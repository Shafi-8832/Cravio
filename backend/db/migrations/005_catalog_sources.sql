-- A logo is a brand mark, never a guessed storefront photo.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS logo_source_url TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS menu_source_url TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS menu_scope VARCHAR(20) DEFAULT 'branch';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS gallery JSONB NOT NULL DEFAULT '[]';
