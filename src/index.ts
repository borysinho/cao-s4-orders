import type { Pool, PoolClient } from 'pg';
import type { Api, Log } from './lib/api.ts';
import type { Response } from 'express';
import type { Purchase, Reservation } from './lib/contracts.ts';
import { createHash } from 'node:crypto';
import { ApiError, conflict, notFound } from './lib/api.ts';
import { internalRequest } from './lib/http.ts';

const customer = { role: 'cliente' } as const;
const organizer = { role: 'organizador' } as const;
const changes = {
  reservation: 'snapshot=$2, organizer_id=$3, amount_minor=$4',
  cancelled: "status='cancelled', failure_code=$2",
  declined: 'payment_declined=true',
  rejected: "status='rejected', failure_code='PAYMENT_DECLINED'",
  paid: "status='paid', ticket_status='pending'",
  issued: "ticket_status='ready'",
  notify: 'notification_status=$2',
};

type FailureCode = 'SOLD_OUT' | 'EVENT_UNAVAILABLE' | 'NOT_FOUND' | 'PAYMENT_DECLINED';

interface Order {
  id: string;
  event_id: string;
  sector_id: string;
  quantity: number;
  customer_id: string;
  request_hash: string;
  created_at: Date;
  status: 'pending' | 'paid' | 'cancelled' | 'rejected';
  ticket_status: 'not_started' | 'pending' | 'ready';
  notification_status: 'not_started' | 'unknown' | 'failed' | 'sent';
  snapshot: Reservation | null;
  amount_minor: string | null;
  failure_code: FailureCode | null;
  payment_declined: boolean;
}

function view(order: Order) {
  return {
    id: order.id, eventId: order.event_id, sectorId: order.sector_id, quantity: order.quantity,
    createdAt: order.created_at.toISOString(), currency: 'BOB', status: order.status,
    ticketStatus: order.ticket_status, notificationStatus: order.notification_status,
    ...(order.snapshot && { unitPriceMinor: order.snapshot.unitPriceMinor, amountMinor: Number(order.amount_minor) }),
    ...(order.failure_code && { failureCode: order.failure_code }),
  };
}

function finalResponse(res: Response, order: Order) {
  const errors: Record<FailureCode, [number, string]> = {
    SOLD_OUT: [409, 'Agotado'],
    EVENT_UNAVAILABLE: [409, 'El evento no admite reservas.'],
    NOT_FOUND: [404, 'El evento o sector no existe.'],
    PAYMENT_DECLINED: [422, 'Pago rechazado.'],
  };
  if (order.failure_code) {
    const [status, message] = errors[order.failure_code];
    throw new ApiError(status, order.failure_code, message, { orderId: order.id });
  }
  const ready = order.status === 'paid' && order.ticket_status === 'ready';
  return res.status(ready ? 200 : 202).json(view(order));
}

function call<Body extends object = Record<string, never>>(
  target: 'events' | 'payments' | 'tickets' | 'notifications',
  operationId: string,
  suffix: string,
  method: string,
  body?: object,
) {
  const upper = target.toUpperCase();
  return internalRequest<Body>(`${upper}_URL`, `${upper}_ORDERS_TOKEN`, `/internal/${target}/${suffix}`, {
    method, operationId, body,
  });
}

async function advance(client: PoolClient, order: Order, request: Purchase, log: Log) {
  const id = order.id;
  const save = async (field: keyof typeof changes, ...values: unknown[]) => {
    const { rows: [record] } = await client.query<Order>(
      `UPDATE orders SET ${changes[field]} WHERE id=$1 RETURNING *`, [id, ...values],
    );
    order = record;
  };
  const wait = (service: string) => {
    log('warn', 'Compra pendiente de respuesta de ' + service + '.', { orderId: id });
    return order;
  };

  if (order.status === 'cancelled' || order.status === 'rejected') return order;
  if (!order.snapshot) {
    const { event_id: eventId, sector_id: sectorId, quantity } = order;
    const result = await call<Reservation>('events', 'reserveCapacity', `reservations/${id}`, 'PUT', {
      eventId, sectorId, quantity,
    });
    const code = result.body?.code;
    if (result.status === 404 || (result.status === 409 && (code === 'SOLD_OUT' || code === 'EVENT_UNAVAILABLE'))) {
      await save('cancelled', result.status === 404 ? 'NOT_FOUND' : code);
      return order;
    }
    if (result.status !== 200 || !result.body) return wait('events');
    const snapshot = result.body;
    if (snapshot.orderId.toLowerCase() !== id || snapshot.eventId.toLowerCase() !== eventId
        || snapshot.sectorId.toLowerCase() !== sectorId || snapshot.quantity !== quantity
        || !Number.isSafeInteger(snapshot.unitPriceMinor * quantity)) {
      return wait('events');
    }
    await save('reservation', snapshot, snapshot.organizerId, snapshot.unitPriceMinor * quantity);
  }
  if (order.status === 'pending' && !order.payment_declined) {
    const result = await call<{ orderId: string; amountMinor: number; status: 'approved' | 'declined' }>(
      'payments', 'processPayment', id, 'PUT', {
      amountMinor: Number(order.amount_minor), currency: 'BOB', paymentCode: request.paymentCode,
    });
    if (result.status !== 200 || !result.body || result.body.orderId.toLowerCase() !== id
        || result.body.amountMinor !== Number(order.amount_minor)) return wait('payments');
    if (result.body.status === 'declined') await save('declined');
    else if (result.body.status === 'approved') await save('paid');
    else return wait('payments');
  }
  if (order.payment_declined) {
    const result = await call('events', 'releaseCapacity', `reservations/${id}`, 'DELETE');
    if (result.status !== 204) return wait('events');
    await save('rejected');
    return order;
  }
  if (!order.snapshot) throw new Error('Falta la instantánea de reserva.');
  if (order.ticket_status !== 'ready') {
    const { eventId, sectorId, quantity, eventName, eventDate, eventVenue, sectorName } = order.snapshot;
    const result = await call<{ items: { id: string; orderId: string; eventId: string }[] }>(
      'tickets', 'issueTickets', `orders/${id}`, 'PUT', {
      customerId: order.customer_id, eventId, sectorId, quantity, eventName, eventDate, eventVenue, sectorName,
    });
    const items = result.body?.items;
    if (result.status !== 200 || items?.length !== quantity
        || items.some((ticket) => ticket.orderId.toLowerCase() !== id || ticket.eventId.toLowerCase() !== order.event_id)
        || new Set(items.map((ticket) => ticket.id.toLowerCase())).size !== quantity) {
      return wait('tickets');
    }
    await save('issued');
  }
  if (order.notification_status === 'not_started') {
    await save('notify', 'unknown');
    const result = await call('notifications', 'sendConfirmation', `orders/${id}`, 'POST', {
      recipientEmail: request.recipientEmail, eventName: order.snapshot.eventName,
    });
    if (result.status === 204) await save('notify', 'sent');
    else if (result.unreachable || result.body?.code === 'SMTP_FAILED') await save('notify', 'failed');
    if (result.status !== 204) log('warn', 'Correo de compra indisponible.', { orderId: id });
  }
  return order;
}

export function mount(api: Api, { pool, log }: { pool: Pool; log: Log }) {
  api.route<Purchase>('purchaseTickets', customer, async (req, res) => {
    const { eventId, sectorId, quantity, recipientEmail, paymentCode } = req.body;
    const key = req.get('Idempotency-Key');
    const hash = createHash('sha256').update(JSON.stringify([eventId, sectorId, quantity, recipientEmail, paymentCode])).digest('hex');
    const { rows: [created] } = await pool.query<Order>(
      `INSERT INTO orders (customer_id, idempotency_key, request_hash, event_id, sector_id, quantity)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (customer_id, idempotency_key) DO NOTHING RETURNING *`,
      [req.actor.sub, key, hash, eventId, sectorId, quantity],
    );
    const known = created ?? (await pool.query<Order>(
      'SELECT * FROM orders WHERE customer_id=$1 AND idempotency_key=$2', [req.actor.sub, key],
    )).rows[0];
    if (known.request_hash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', 'La clave ya corresponde a otra solicitud.');
    if (created) log('info', 'Orden creada.', { orderId: known.id });

    const client = await pool.connect();
    let locked = false;
    let discard = true;
    try {
      const { rows: [lock] } = await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [known.id],
      );
      locked = lock.locked;
      discard = false;
      const { rows: [current] } = await client.query<Order>('SELECT * FROM orders WHERE id=$1', [known.id]);
      const order = locked ? await advance(client, current, req.body, log) : current;
      return finalResponse(res, order);
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [known.id]);
        } catch {
          discard = true;
        }
      }
      client.release(discard);
    }
  });

  api.route('listOwnOrders', customer, async (req, res) => {
    const { rows } = await pool.query<Order>('SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC, id', [req.actor.sub]);
    res.json({ items: rows.map(view) });
  });

  api.route('getOwnOrder', customer, async (req, res) => {
    const { rows: [row] } = await pool.query<Order>(
      'SELECT * FROM orders WHERE customer_id=$1 AND id=$2', [req.actor.sub, req.params.orderId],
    );
    if (!row) throw notFound();
    res.json(view(row));
  });

  api.route('getSales', organizer, async (req, res) => {
    const { eventId } = req.params;
    const { rows: [row] } = await pool.query(
      `SELECT COALESCE(SUM(quantity),0) AS tickets, COALESCE(SUM(amount_minor),0) AS revenue
       FROM orders WHERE status='paid' AND organizer_id=$1 AND event_id=$2`,
      [req.actor.sub, eventId],
    );
    res.json({ eventId, ticketsSold: Number(row.tickets), revenueMinor: Number(row.revenue), currency: 'BOB' });
  });
}
