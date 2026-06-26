package config

import "testing"

func TestLoadPublicBaseGuard(t *testing.T) {
	cases := []struct {
		name       string
		endpoint   string
		publicBase string
		wantErr    bool
	}{
		{name: "endpoint set, public base empty -> error", endpoint: "https://storage.yandexcloud.net", publicBase: "", wantErr: true},
		{name: "endpoint set, public base set -> ok", endpoint: "https://storage.yandexcloud.net", publicBase: "https://cdn.example.com", wantErr: false},
		{name: "endpoint empty, public base empty -> ok (AWS default)", endpoint: "", publicBase: "", wantErr: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("BUCKET", "test-bucket")
			t.Setenv("S3_ENDPOINT_URL", tc.endpoint)
			t.Setenv("EXCERPTS_PUBLIC_BASE", tc.publicBase)

			_, err := Load()
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}
