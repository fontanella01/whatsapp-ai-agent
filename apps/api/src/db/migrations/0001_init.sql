-- 0001: agents, WhatsApp contacts and conversations, knowledge base and the job queue.
-- Constraints live in the database too, so a bug in the code cannot store an invalid state.

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per WhatsApp number that ever wrote to the business.
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE CHECK (phone ~ '^[0-9]{8,15}$'),
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One conversation per contact. `mode` says who answers: the AI or a human agent.
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'human')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  handoff_reason text,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_inbox_idx ON conversations (status, last_message_at DESC);

-- external_id is the WhatsApp message id. Meta may deliver the same webhook more
-- than once, so it is UNIQUE: a repeated delivery cannot create a second message.
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  sender text NOT NULL CHECK (sender IN ('customer', 'ai', 'agent', 'system')),
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4096),
  external_id text UNIQUE,
  delivery text NOT NULL CHECK (delivery IN ('received', 'pending', 'sent', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- arrival order, even for messages saved in the same millisecond
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, seq);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 160),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 50000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Documents are split into small chunks; the AI receives only the chunks that match
-- the customer's question. `search` is kept up to date by PostgreSQL itself.
CREATE TABLE IF NOT EXISTS chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position integer NOT NULL,
  content text NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS chunks_search_idx ON chunks USING gin (search);

-- Work that happens after the webhook has already answered: generating the AI reply
-- and sending messages to WhatsApp. Failed jobs are retried with backoff.
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('reply', 'send')),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (status, run_at);
-- At most one pending reply per conversation: a customer who sends three messages
-- in a row gets one answer that reads all three, not three answers.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_pending_reply ON jobs (conversation_id) WHERE type = 'reply' AND status = 'queued';
