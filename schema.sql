-- The Bosso Movie — Outreach & Fundraising Tool
-- This mirrors the schema already applied live in the "bosso" D1 database.
-- Kept here so the schema lives in source control alongside the Worker code.
-- Safe to re-run: every statement uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  role TEXT CHECK(role IN ('admin','team_member')) DEFAULT 'team_member',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  track TEXT NOT NULL CHECK (track IN ('corporate','local_community','crowdfunding','tickets','merch','diaspora_stream')),
  target_amount REAL NOT NULL,
  window_start TEXT NOT NULL DEFAULT '2026-08-24',
  window_end TEXT NOT NULL DEFAULT '2026-10-15',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  track TEXT NOT NULL CHECK (track IN ('corporate','local_community')),
  tier TEXT CHECK (tier IN ('founding_presenting','principal','official_category','product_integration','supporting','event','in_kind')),
  category TEXT,
  visibility_tiers TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'not_contacted' CHECK (status IN ('not_contacted','contacted','meeting_booked','proposal_sent','negotiating','won','lost')),
  value_target REAL DEFAULT 0,
  value_actual REAL DEFAULT 0,
  in_kind_value REAL DEFAULT 0,
  owner_id TEXT REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_partners_track_status ON partners(track, status);
CREATE INDEX IF NOT EXISTS idx_partners_owner ON partners(owner_id);

CREATE TABLE IF NOT EXISTS placement_scenes (
  id TEXT PRIMARY KEY,
  scene_name TEXT,
  category TEXT,
  visibility_tier TEXT,
  uses_official_ip INTEGER DEFAULT 1,
  status TEXT DEFAULT 'open',
  linked_partner_id TEXT REFERENCES partners(id),
  fictional_fallback_name TEXT,
  locks_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS in_kind_partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contribution_type TEXT,
  estimated_value REAL,
  linked_partner_id TEXT REFERENCES partners(id),
  status TEXT DEFAULT 'pledged',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  contributor_name TEXT NOT NULL,
  contributor_phone TEXT,
  contributor_email TEXT,
  tier TEXT NOT NULL,
  amount REAL NOT NULL,
  city TEXT,
  premiere_slot_number INTEGER,
  payment_ref TEXT,
  source TEXT,
  show_on_supporter_wall INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contributions_tier ON contributions(tier);
CREATE INDEX IF NOT EXISTS idx_contributions_created ON contributions(created_at);

CREATE TABLE IF NOT EXISTS tier_caps (
  tier TEXT PRIMARY KEY,
  max_slots INTEGER,
  slots_taken INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contribution_fulfilment (
  id TEXT PRIMARY KEY,
  contribution_id TEXT REFERENCES contributions(id),
  item TEXT,
  size TEXT,
  status TEXT DEFAULT 'pending',
  delivery_method TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS diaspora_streams (
  id TEXT PRIMARY KEY,
  contribution_id TEXT REFERENCES contributions(id),
  stream_token TEXT,
  premiere_city TEXT,
  valid_from TEXT,
  valid_until TEXT,
  max_concurrent_views INTEGER DEFAULT 1,
  delivered INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS diaspora_merch_shipments (
  id TEXT PRIMARY KEY,
  host_contribution_id TEXT REFERENCES contributions(id),
  destination_country TEXT,
  destination_city TEXT,
  item_counts TEXT,
  courier TEXT,
  tracking_ref TEXT,
  ship_by_date TEXT,
  status TEXT DEFAULT 'pending',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS ticket_sales (
  id TEXT PRIMARY KEY,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT,
  city TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  amount REAL NOT NULL,
  payment_ref TEXT,
  sold_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS merch_sales (
  id TEXT PRIMARY KEY,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT,
  item TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  amount REAL NOT NULL,
  payment_ref TEXT,
  sold_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS community_reps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  branch_area TEXT,
  phone TEXT,
  role TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  linked_table TEXT,
  linked_id TEXT,
  user_id TEXT REFERENCES users(id),
  type TEXT,
  notes TEXT,
  next_action TEXT,
  next_action_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_next_action ON activities(next_action_date);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,
  track TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  attachment_ids TEXT,
  is_reviewed INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_key TEXT NOT NULL,
  file_type TEXT,
  track TEXT,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outreach_log (
  id TEXT PRIMARY KEY,
  linked_partner_id TEXT REFERENCES partners(id),
  channel TEXT NOT NULL,
  template_id TEXT REFERENCES templates(id),
  final_body TEXT NOT NULL,
  attachments TEXT,
  sent_by TEXT REFERENCES users(id),
  sent_at TEXT DEFAULT (datetime('now')),
  reply_status TEXT DEFAULT 'awaiting'
);
CREATE INDEX IF NOT EXISTS idx_outreach_partner ON outreach_log(linked_partner_id);

CREATE TABLE IF NOT EXISTS reply_guides (
  id TEXT PRIMARY KEY,
  trigger_status TEXT,
  track TEXT,
  suggested_response TEXT,
  suggested_next_action TEXT
);

CREATE TABLE IF NOT EXISTS hints (
  id TEXT PRIMARY KEY,
  context TEXT,
  track TEXT,
  tier TEXT,
  hint_text TEXT
);

CREATE TABLE IF NOT EXISTS content_posts (
  id TEXT PRIMARY KEY,
  platform TEXT,
  post_type TEXT,
  linked_partner_id TEXT REFERENCES partners(id),
  status TEXT DEFAULT 'planned',
  scheduled_date TEXT,
  posted_date TEXT,
  owner_id TEXT REFERENCES users(id),
  notes TEXT
);
