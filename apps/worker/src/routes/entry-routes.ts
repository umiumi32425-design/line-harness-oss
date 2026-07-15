import { Hono } from 'hono';
import {
  getEntryRoutes,
  getEntryRouteById,
  createEntryRoute,
  updateEntryRoute,
  deleteEntryRoute,
  getEntryRouteFunnel,
} from '@line-crm/db';
import type { EntryRoute } from '@line-crm/db';
import type { Env } from '../index.js';

const entryRoutes = new Hono<Env>();

function serialize(row: EntryRoute) {
  return {
    id: row.id,
    refCode: row.ref_code,
    name: row.name,
    tagId: row.tag_id,
    scenarioId: row.scenario_id,
    redirectUrl: row.redirect_url,
    poolId: row.pool_id,
    introTemplateId: row.intro_template_id,
    runAccountFriendAddScenarios: row.run_account_friend_add_scenarios === 1,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/entry-routes — list all
entryRoutes.get('/api/entry-routes', async (c) => {
  try {
    const rows = await getEntryRoutes(c.env.DB);
    return c.json({ success: true, data: rows.map(serialize) });
  } catch (err) {
    console.error('GET /api/entry-routes error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/entry-routes/:id — single
entryRoutes.get('/api/entry-routes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await getEntryRouteById(c.env.DB, id);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    console.error('GET /api/entry-routes/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/entry-routes — create
entryRoutes.post('/api/entry-routes', async (c) => {
  try {
    const body = await c.req.json<{
      refCode: string;
      name: string;
      tagId?: string | null;
      scenarioId?: string | null;
      redirectUrl?: string | null;
      poolId?: string | null;
      introTemplateId?: string | null;
      runAccountFriendAddScenarios?: boolean;
      isActive?: boolean;
    }>();
    if (!body.refCode || !body.name) {
      return c.json({ success: false, error: 'refCode and name are required' }, 400);
    }
    const row = await createEntryRoute(c.env.DB, body);
    return c.json({ success: true, data: serialize(row) }, 201);
  } catch (err) {
    // D1 surfaces UNIQUE/FOREIGN KEY constraint violations as thrown errors
    // (e.g. duplicate refCode, or tagId/scenarioId pointing at a row that
    // doesn't exist). Surface those as 409/400 instead of masking as 500 —
    // see line-accounts.ts / traffic-pools.ts for the same pattern.
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(message)) {
      return c.json({ success: false, error: 'refCode already exists' }, 409);
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
      return c.json({ success: false, error: 'tagId, scenarioId, poolId, or introTemplateId references a row that does not exist' }, 400);
    }
    console.error('POST /api/entry-routes error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/entry-routes/:id — update
entryRoutes.patch('/api/entry-routes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<
      Partial<{
        refCode: string;
        name: string;
        tagId: string | null;
        scenarioId: string | null;
        redirectUrl: string | null;
        poolId: string | null;
        introTemplateId: string | null;
        runAccountFriendAddScenarios: boolean;
        isActive: boolean;
      }>
    >();
    const row = await updateEntryRoute(c.env.DB, id, body);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(row) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(message)) {
      return c.json({ success: false, error: 'refCode already exists' }, 409);
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
      return c.json({ success: false, error: 'tagId, scenarioId, poolId, or introTemplateId references a row that does not exist' }, 400);
    }
    console.error('PATCH /api/entry-routes/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/entry-routes/:id
entryRoutes.delete('/api/entry-routes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteEntryRoute(c.env.DB, id);
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/entry-routes/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/entry-routes/:id/funnel
entryRoutes.get('/api/entry-routes/:id/funnel', async (c) => {
  try {
    const id = c.req.param('id');
    const route = await getEntryRouteById(c.env.DB, id);
    if (!route) return c.json({ success: false, error: 'Not found' }, 404);
    const funnel = await getEntryRouteFunnel(c.env.DB, id);
    return c.json({ success: true, data: funnel });
  } catch (err) {
    console.error('GET /api/entry-routes/:id/funnel error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { entryRoutes };
