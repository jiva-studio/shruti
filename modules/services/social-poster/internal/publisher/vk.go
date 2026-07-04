package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jiva-studio/lectorium-social-poster/internal/config"
)

const vkAPIVersion = "5.199"

// VK publishes to a community wall: upload the poster photo, then wall.post
// it (as the community) with the photo and any pre-mapped audio attachment.
type VK struct {
	name    string
	token   string
	groupID string // numeric, e.g. "123456"
	httpc   *http.Client
}

func NewVK(name, token, groupID string, httpc *http.Client) *VK {
	if httpc == nil {
		httpc = &http.Client{Timeout: 60 * time.Second}
	}
	return &VK{name: name, token: token, groupID: groupID, httpc: httpc}
}

func (v *VK) Name() string     { return v.name }
func (v *VK) Platform() string { return config.PlatformVK }

func (v *VK) Publish(ctx context.Context, p Post) (Result, error) {
	var attachments []string

	if p.ImageURL != "" {
		att, err := v.uploadWallPhoto(ctx, p.ImageURL)
		if err != nil {
			return Result{}, err
		}
		attachments = append(attachments, att)
	}
	if p.AudioRef != "" {
		attachments = append(attachments, p.AudioRef)
	}

	form := url.Values{}
	form.Set("owner_id", "-"+v.groupID)
	form.Set("from_group", "1")
	form.Set("message", p.Text)
	if len(attachments) > 0 {
		form.Set("attachments", strings.Join(attachments, ","))
	}

	var out struct {
		Response struct {
			PostID int64 `json:"post_id"`
		} `json:"response"`
	}
	if err := v.method(ctx, "wall.post", form, &out); err != nil {
		return Result{}, err
	}
	return Result{Ref: fmt.Sprintf("%d", out.Response.PostID)}, nil
}

// uploadWallPhoto runs VK's three-step photo upload and returns the
// "photo{owner}_{id}" attachment string.
func (v *VK) uploadWallPhoto(ctx context.Context, imageURL string) (string, error) {
	var server struct {
		Response struct {
			UploadURL string `json:"upload_url"`
		} `json:"response"`
	}
	if err := v.method(ctx, "photos.getWallUploadServer", url.Values{"group_id": {v.groupID}}, &server); err != nil {
		return "", err
	}

	img, err := v.fetch(ctx, imageURL)
	if err != nil {
		return "", err
	}

	var uploaded struct {
		Server int    `json:"server"`
		Photo  string `json:"photo"`
		Hash   string `json:"hash"`
	}
	if err := v.postMultipart(ctx, server.Response.UploadURL, "photo", "poster.jpg", img, &uploaded); err != nil {
		return "", err
	}
	if uploaded.Photo == "" || uploaded.Photo == "[]" {
		return "", fmt.Errorf("vk photo upload returned empty payload")
	}

	var saved struct {
		Response []struct {
			OwnerID int64 `json:"owner_id"`
			ID      int64 `json:"id"`
		} `json:"response"`
	}
	sv := url.Values{
		"group_id": {v.groupID},
		"server":   {fmt.Sprintf("%d", uploaded.Server)},
		"photo":    {uploaded.Photo},
		"hash":     {uploaded.Hash},
	}
	if err := v.method(ctx, "photos.saveWallPhoto", sv, &saved); err != nil {
		return "", err
	}
	if len(saved.Response) == 0 {
		return "", fmt.Errorf("vk saveWallPhoto returned no photos")
	}
	ph := saved.Response[0]
	return fmt.Sprintf("photo%d_%d", ph.OwnerID, ph.ID), nil
}

// method calls a VK API method (POST form) and decodes response into dst,
// mapping VK's {error:{…}} envelope to a Go error.
func (v *VK) method(ctx context.Context, name string, form url.Values, dst any) error {
	form.Set("access_token", v.token)
	form.Set("v", vkAPIVersion)
	endpoint := "https://api.vk.com/method/" + name
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := v.httpc.Do(req)
	if err != nil {
		return fmt.Errorf("vk %s: %w", name, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	var envelope struct {
		Error *struct {
			Code int    `json:"error_code"`
			Msg  string `json:"error_msg"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &envelope)
	if envelope.Error != nil {
		return fmt.Errorf("vk %s error %d: %s", name, envelope.Error.Code, envelope.Error.Msg)
	}
	if dst != nil {
		if err := json.Unmarshal(raw, dst); err != nil {
			return fmt.Errorf("vk %s: decode: %w", name, err)
		}
	}
	return nil
}

func (v *VK) fetch(ctx context.Context, u string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	resp, err := v.httpc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch image: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch image %s: status %d", u, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func (v *VK) postMultipart(ctx context.Context, uploadURL, field, filename string, data []byte, dst any) error {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile(field, filename)
	if err != nil {
		return err
	}
	if _, err := fw.Write(data); err != nil {
		return err
	}
	mw.Close()

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := v.httpc.Do(req)
	if err != nil {
		return fmt.Errorf("vk upload: %w", err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		return fmt.Errorf("vk upload: decode: %w", err)
	}
	return nil
}
