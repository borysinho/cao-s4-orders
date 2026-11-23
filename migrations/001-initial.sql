CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  event_id uuid NOT NULL,
  sector_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb,
  organizer_id uuid,
  amount_minor bigint CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected','cancelled')),
  payment_declined boolean NOT NULL DEFAULT false,
  failure_code text,
  ticket_status text NOT NULL DEFAULT 'not_started' CHECK (ticket_status IN ('not_started','pending','ready')),
  notification_status text NOT NULL DEFAULT 'not_started' CHECK (notification_status IN ('not_started','unknown','sent','failed')),
  UNIQUE (customer_id, idempotency_key)
);

CREATE INDEX orders_paid_sales ON orders (organizer_id, event_id) WHERE status = 'paid';
