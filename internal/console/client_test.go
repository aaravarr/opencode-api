package console

import (
	"encoding/json"
	"testing"
)

func TestMicroCentsToCents(t *testing.T) {
	var value MicroCents
	if err := json.Unmarshal([]byte(`4200000`), &value); err != nil {
		t.Fatal(err)
	}
	if got := value.Cents(); got != 42 {
		t.Fatalf("Cents() = %v, want 42", got)
	}

	if err := json.Unmarshal([]byte(`"95800000"`), &value); err != nil {
		t.Fatal(err)
	}
	if got := value.Cents(); got != 958 {
		t.Fatalf("Cents() for string = %v, want 958", got)
	}
}

func TestDecodeOptionalSpendCheck(t *testing.T) {
	spend, ok, err := decodeOptionalSpendCheck([]byte(`{"_tag":"Some","value":{"scope":"org","limitMicroCents":"100000000","spentMicroCents":"4200000","exceeded":false}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if got := spend.RemainingCents(); got != 958 {
		t.Fatalf("RemainingCents() = %v, want 958", got)
	}

	_, ok, err = decodeOptionalSpendCheck([]byte(`{"_tag":"None"}`))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("ok = true, want false")
	}
}
