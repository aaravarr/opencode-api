package keystore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type Store struct {
	Version  int               `json:"version"`
	Updated  time.Time         `json:"updated_at"`
	Accounts map[string]Record `json:"accounts"`
}

type Record struct {
	APIKey    string    `json:"api_key"`
	SourceURL string    `json:"source_url,omitempty"`
	UpdatedAt time.Time `json:"updated_at"`
}

func Load(path string) (*Store, error) {
	store := &Store{
		Version:  1,
		Accounts: map[string]Record{},
	}
	if path == "" {
		return store, nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return store, nil
	}
	if err := json.Unmarshal(b, store); err != nil {
		return nil, err
	}
	if store.Version == 0 {
		store.Version = 1
	}
	if store.Accounts == nil {
		store.Accounts = map[string]Record{}
	}
	return store, nil
}

func Get(path, accountID string) (Record, bool, error) {
	store, err := Load(path)
	if err != nil {
		return Record{}, false, err
	}
	rec, ok := store.Accounts[accountID]
	return rec, ok && rec.APIKey != "", nil
}

func Put(path, accountID, apiKey, sourceURL string) error {
	store, err := Load(path)
	if err != nil {
		return err
	}
	now := time.Now()
	store.Version = 1
	store.Updated = now
	store.Accounts[accountID] = Record{
		APIKey:    apiKey,
		SourceURL: sourceURL,
		UpdatedAt: now,
	}
	return Save(path, store)
}

func Delete(path, accountID string) error {
	store, err := Load(path)
	if err != nil {
		return err
	}
	delete(store.Accounts, accountID)
	store.Updated = time.Now()
	return Save(path, store)
}

func Save(path string, store *Store) error {
	if path == "" {
		return errors.New("key store path is required")
	}
	if store == nil {
		store = &Store{Version: 1, Accounts: map[string]Record{}}
	}
	if store.Accounts == nil {
		store.Accounts = map[string]Record{}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
