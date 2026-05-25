package service

import (
	"testing"
	"time"

	"github.com/akdasa-studios/shruti/auth/internal/rcclient"
)

func TestSnapshotFromRCResponse(t *testing.T) {
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	future := now.Add(30 * 24 * time.Hour)
	past := now.Add(-1 * time.Hour)

	tests := []struct {
		name        string
		resp        *rcclient.SubscriberResponse
		wantTier    string
		wantExpires *time.Time
	}{
		{
			name:     "nil response",
			resp:     nil,
			wantTier: TierFree,
		},
		{
			name:     "empty response (no subscriber)",
			resp:     &rcclient.SubscriberResponse{},
			wantTier: TierFree,
		},
		{
			name: "no entitlements",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
				},
			},
			wantTier: TierFree,
		},
		{
			name: "expired entitlement is free",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
					Entitlements: map[string]rcclient.Entitlement{
						"pro": {ExpiresDate: &past},
					},
				},
			},
			wantTier: TierFree,
		},
		{
			name: "active entitlement is pro",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
					Entitlements: map[string]rcclient.Entitlement{
						"pro": {ExpiresDate: &future},
					},
				},
			},
			wantTier:    TierPro,
			wantExpires: &future,
		},
		{
			name: "lifetime entitlement is pro with nil expires",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
					Entitlements: map[string]rcclient.Entitlement{
						"pro": {ExpiresDate: nil},
					},
				},
			},
			wantTier:    TierPro,
			wantExpires: nil,
		},
		{
			name: "lifetime beats any dated entitlement",
			resp: &rcclient.SubscriberResponse{
				Subscriber: &rcclient.Subscriber{
					OriginalAppUserID: "app_user_1",
					Entitlements: map[string]rcclient.Entitlement{
						"pro":      {ExpiresDate: &future},
						"lifetime": {ExpiresDate: nil},
					},
				},
			},
			wantTier:    TierPro,
			wantExpires: nil,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := SnapshotFromRCResponse("app_user_1", tc.resp, now)
			if got.Tier != tc.wantTier {
				t.Errorf("tier: got %q, want %q", got.Tier, tc.wantTier)
			}
			if (got.TierExpiresAt == nil) != (tc.wantExpires == nil) {
				t.Errorf("expires nil-ness: got %v, want %v", got.TierExpiresAt, tc.wantExpires)
			}
			if got.TierExpiresAt != nil && tc.wantExpires != nil && !got.TierExpiresAt.Equal(*tc.wantExpires) {
				t.Errorf("expires: got %v, want %v", *got.TierExpiresAt, *tc.wantExpires)
			}
			if got.AppUserID != "app_user_1" {
				t.Errorf("AppUserID lost: got %q", got.AppUserID)
			}
		})
	}
}
