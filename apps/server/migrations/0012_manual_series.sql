CREATE TABLE asset_series_links (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  linked_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, linked_asset_id)
);
