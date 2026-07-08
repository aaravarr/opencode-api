package browser

import "testing"

func TestExtractAPIKeysAcceptsLikelyOpenCodeKey(t *testing.T) {
	text := `OpenCode API Key: oc_test_abcdefghijklmnopqrstuvwxyz123456`
	got := ExtractAPIKeys(text)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Value != "oc_test_abcdefghijklmnopqrstuvwxyz123456" {
		t.Fatalf("value = %q", got[0].Value)
	}
}

func TestExtractAPIKeysRejectsGoogleTokens(t *testing.T) {
	text := `access_token: ya29.A0ARrdaM_not_an_opencode_key API key AIzaSyNotWanted1234567890`
	got := ExtractAPIKeys(text)
	if len(got) != 0 {
		t.Fatalf("len = %d, want 0: %#v", len(got), got)
	}
}

func TestExtractAPIKeysRequiresContextForSK(t *testing.T) {
	text := `api key: sk-abcdefghijklmnopqrstuvwxyz1234567890`
	got := ExtractAPIKeys(text)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}

	text = `random string sk-abcdefghijklmnopqrstuvwxyz1234567890 with no useful words`
	got = ExtractAPIKeys(text)
	if len(got) != 0 {
		t.Fatalf("len = %d, want 0", len(got))
	}
}
