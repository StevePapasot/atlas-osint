import { beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import Papa from 'papaparse';
import { setupDb, makeUser } from '../helpers/db';
import { makeExifJpeg, makePdf, makeZipBomb } from '../helpers/fixtures';
import { db } from '@/server/db/client';
import { processNextJob } from '@/server/engine/runner';
import * as investigationsRoute from '@/app/api/investigations/route';
import * as investigationRoute from '@/app/api/investigations/[id]/route';
import * as findingsRoute from '@/app/api/investigations/[id]/findings/route';
import * as reviewRoute from '@/app/api/investigations/[id]/findings/[findingId]/review/route';
import * as artifactsRoute from '@/app/api/investigations/[id]/artifacts/route';
import * as reportsRoute from '@/app/api/investigations/[id]/reports/route';
import * as reportRoute from '@/app/api/investigations/[id]/reports/[reportId]/route';
import * as exportRoute from '@/app/api/investigations/[id]/export/route';
import * as startRoute from '@/app/api/investigations/[id]/start/route';
import * as progressRoute from '@/app/api/investigations/[id]/progress/route';
import * as providersRoute from '@/app/api/providers/route';
import * as healthRoute from '@/app/api/health/route';

const ORIGIN = 'http://localhost:3000';

interface CallOptions {
  method?: string;
  cookie?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;

async function call<P>(handler: Handler<P>, path: string, params: P, opts: CallOptions = {}) {
  const headers = new Headers({ host: 'localhost:3000', ...opts.headers });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  let body = opts.body;
  if (opts.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(opts.json);
  }
  const method = opts.method ?? 'GET';
  if (method !== 'GET' && !headers.has('origin')) headers.set('origin', ORIGIN);
  const req = new NextRequest(new URL(path, ORIGIN), { method, headers, body });
  const res = await handler(req, { params: Promise.resolve(params) });
  return res;
}

async function json(res: Response) {
  return (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const demoInput = {
  name: 'API demo (fictional)',
  depth: 'standard',
  mode: 'demo',
  targets: [
    { type: 'username', value: 'shadowfox_42' },
    { type: 'domain', value: 'northwind-analytics.example' },
  ],
};

let owner: Awaited<ReturnType<typeof makeUser>>;
let intruder: Awaited<ReturnType<typeof makeUser>>;
let investigationId = '';

beforeAll(async () => {
  await setupDb();
  owner = await makeUser('Owner');
  intruder = await makeUser('Intruder');
});

describe('authentication and request hygiene', () => {
  it('health is public and reveals no configuration secrets', async () => {
    const res = await call(healthRoute.GET, '/api/health', {});
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe('ok');
    expect(JSON.stringify(body)).not.toMatch(/key|token|secret|password/i);
  });

  it('rejects unauthenticated access with 401', async () => {
    const res = await call(investigationsRoute.GET, '/api/investigations', {});
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe('unauthorized');
  });

  it('rejects a forged or expired session token', async () => {
    const res = await call(investigationsRoute.GET, '/api/investigations', {}, { cookie: 'atlas_session=not-a-real-token' });
    expect(res.status).toBe(401);
  });

  it('rejects cross-origin mutations (CSRF) even with a valid session', async () => {
    const res = await call(investigationsRoute.POST, '/api/investigations', {}, { method: 'POST', cookie: owner.cookie, json: demoInput, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('csrf_rejected');
    const res2 = await call(investigationsRoute.POST, '/api/investigations', {}, { method: 'POST', cookie: owner.cookie, json: demoInput, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res2.status).toBe(403);
  });

  it('requires JSON bodies and validates input', async () => {
    const form = await call(investigationsRoute.POST, '/api/investigations', {}, { method: 'POST', cookie: owner.cookie, body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
    const malformed = await call(investigationsRoute.POST, '/api/investigations', {}, { method: 'POST', cookie: owner.cookie, body: '{"name":', headers: { 'content-type': 'application/json' } });
    expect(malformed.status).toBe(400);
    expect((await json(malformed)).error.code).toBe('invalid_json');
    const invalid = await call(investigationsRoute.POST, '/api/investigations', {}, { method: 'POST', cookie: owner.cookie, json: { name: 'x', depth: 'extreme' } });
    expect(invalid.status).toBe(400);
    const body = await json(invalid);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['name', 'depth']));
  });

  it('reports every invalid target at once', async () => {
    const res = await call(investigationsRoute.POST, '/api/investigations', {}, {
      method: 'POST',
      cookie: owner.cookie,
      json: { name: 'Bad targets', targets: [{ type: 'ip', value: '999.1.1.1' }, { type: 'email', value: 'not-an-email' }, { type: 'domain', value: 'ok.example' }] },
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe('invalid_targets');
    expect(body.error.details.map((d: { index: number }) => d.index)).toEqual([0, 1]);
  });
});

describe('investigation lifecycle over the API', () => {
  it('creates and starts a demo investigation', async () => {
    const res = await call(investigationsRoute.POST, '/api/investigations', {}, { method: 'POST', cookie: owner.cookie, json: { ...demoInput, start: true } });
    expect(res.status).toBe(201);
    const body = await json(res);
    investigationId = body.investigation.id;
    expect(body.jobId).toBeTruthy();
    expect(body.investigation.mode).toBe('demo');
    expect(await processNextJob(db())).toMatch(/completed/);
    const progress = await json(await call(progressRoute.GET, `/api/investigations/${investigationId}/progress`, { id: investigationId }, { cookie: owner.cookie }));
    expect(progress.status).toMatch(/completed/);
    expect(progress.tasks.length).toBeGreaterThan(5);
  });

  it('lists findings with filters, sorting and pagination', async () => {
    const all = await json(await call(findingsRoute.GET, `/api/investigations/${investigationId}/findings?pageSize=5&sort=confidence&order=desc`, { id: investigationId }, { cookie: owner.cookie }));
    expect(all.items.length).toBe(5);
    expect(all.total).toBeGreaterThan(5);
    expect(all.items.every((f: { isSimulated: boolean }) => f.isSimulated)).toBe(true);
    const filtered = await json(await call(findingsRoute.GET, `/api/investigations/${investigationId}/findings?category=dns`, { id: investigationId }, { cookie: owner.cookie }));
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.every((f: { category: string }) => f.category === 'dns')).toBe(true);
    const bad = await call(findingsRoute.GET, `/api/investigations/${investigationId}/findings?pageSize=100000`, { id: investigationId }, { cookie: owner.cookie });
    expect(bad.status).toBe(400);
  });

  it('requires a rationale to verify a finding and records the decision', async () => {
    const list = await json(await call(findingsRoute.GET, `/api/investigations/${investigationId}/findings?pageSize=1`, { id: investigationId }, { cookie: owner.cookie }));
    const findingId = list.items[0].id as string;
    const params = { id: investigationId, findingId };
    const missing = await call(reviewRoute.POST, '/x', params, { method: 'POST', cookie: owner.cookie, json: { status: 'verified' } });
    expect(missing.status).toBe(400);
    const ok = await call(reviewRoute.POST, '/x', params, { method: 'POST', cookie: owner.cookie, json: { status: 'verified', rationale: 'Checked against two independent fictional sources.' } });
    expect(ok.status).toBe(200);
    const detail = await json(ok);
    expect(detail.verificationStatus).toBe('verified');
    expect(detail.reviews[0].rationale).toContain('independent');
  });

  it("hides other users' investigations behind 404 (no ID probing)", async () => {
    const p = { id: investigationId };
    for (const [handler, path] of [
      [investigationRoute.GET, `/api/investigations/${investigationId}`],
      [findingsRoute.GET, `/api/investigations/${investigationId}/findings`],
      [reportsRoute.GET, `/api/investigations/${investigationId}/reports`],
      [exportRoute.GET, `/api/investigations/${investigationId}/export?format=json`],
      [progressRoute.GET, `/api/investigations/${investigationId}/progress`],
    ] as const) {
      const res = await call(handler as Handler<{ id: string }>, path, p, { cookie: intruder.cookie });
      expect(res.status, path).toBe(404);
    }
    const del = await call(investigationRoute.DELETE, `/api/investigations/${investigationId}`, p, { method: 'DELETE', cookie: intruder.cookie });
    expect(del.status).toBe(404);
    const start = await call(startRoute.POST, `/api/investigations/${investigationId}/start`, p, { method: 'POST', cookie: intruder.cookie, json: {} });
    expect(start.status).toBe(404);
    const patch = await call(investigationRoute.PATCH, `/api/investigations/${investigationId}`, p, { method: 'PATCH', cookie: intruder.cookie, json: { name: 'hijacked' } });
    expect(patch.status).toBe(404);
    const own = await json(await call(investigationRoute.GET, `/api/investigations/${investigationId}`, p, { cookie: owner.cookie }));
    expect(own.investigation?.name ?? own.name).toBe('API demo (fictional)');
    // Malformed IDs are a clean 404, not a database error.
    const weird = await call(investigationRoute.GET, `/api/investigations/1' OR '1'='1`, { id: "1' OR '1'='1" }, { cookie: owner.cookie });
    expect(weird.status).toBe(404);
  });
});

describe('reports and exports', () => {
  let reportId = '';
  it('generates a stored report and downloads it in every format', async () => {
    const res = await call(reportsRoute.POST, '/x', { id: investigationId }, { method: 'POST', cookie: owner.cookie, json: { title: 'API report' } });
    expect(res.status).toBe(201);
    reportId = (await json(res)).id;
    const params = { id: investigationId, reportId };
    const pdf = await call(reportRoute.GET, `/x?format=pdf`, params, { cookie: owner.cookie });
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    expect(pdf.headers.get('content-disposition')).toMatch(/attachment; filename="atlas-.*\.pdf"/);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    const md = await (await call(reportRoute.GET, `/x?format=markdown`, params, { cookie: owner.cookie })).text();
    expect(md).toContain('# API report');
    expect(md).toMatch(/simulated/i);
    const csv = await (await call(reportRoute.GET, `/x?format=csv`, params, { cookie: owner.cookie })).text();
    expect(csv.split('\n')[0]).toMatch(/finding_id/);
    const js = await json(await call(reportRoute.GET, `/x?format=json`, params, { cookie: owner.cookie }));
    expect(js.stats.findings).toBeGreaterThan(0);
    expect(js.containsSimulatedData).toBe(true);
    const bad = await call(reportRoute.GET, `/x?format=exe`, params, { cookie: owner.cookie });
    expect(bad.status).toBe(400);
  });

  it('keeps stored reports reproducible after the investigation changes', async () => {
    const params = { id: investigationId, reportId };
    const before = await (await call(reportRoute.GET, `/x?format=json`, params, { cookie: owner.cookie })).text();
    const list = await json(await call(findingsRoute.GET, `/api/investigations/${investigationId}/findings?pageSize=3`, { id: investigationId }, { cookie: owner.cookie }));
    await call(reviewRoute.POST, '/x', { id: investigationId, findingId: list.items[2].id }, { method: 'POST', cookie: owner.cookie, json: { status: 'rejected', rationale: 'Fictional source contradicted by registry record.' } });
    const after = await (await call(reportRoute.GET, `/x?format=json`, params, { cookie: owner.cookie })).text();
    expect(after).toBe(before);
  });

  it('exports CSV with spreadsheet-formula neutralisation and supports redaction', async () => {
    // Collected text is attacker-controlled: plant a formula and an email address in a finding title.
    const target = await db().selectFrom('findings').select('id').where('investigation_id', '=', investigationId).limit(1).executeTakeFirstOrThrow();
    await db().updateTable('findings').set({ title: '=HYPERLINK("http://evil.example","x") contact jane.roe@example.net' }).where('id', '=', target.id).execute();
    const csv = await (await call(exportRoute.GET, `/x?format=csv`, { id: investigationId }, { cookie: owner.cookie })).text();
    const rows = Papa.parse<string[]>(csv.trim(), { skipEmptyLines: true }).data;
    expect(rows.length).toBeGreaterThan(1);
    // Text cells that could start a spreadsheet formula are prefixed; plain numbers (e.g. -9.13) are safe as-is.
    for (const cell of rows.slice(1).flat()) {
      if (/^[=+\-@\t\r]/.test(cell)) expect(cell).toMatch(/^-?\d+(\.\d+)?$/);
    }
    expect(rows.flat()).toContain(`'=HYPERLINK("http://evil.example","x") contact jane.roe@example.net`);
    const plain = await (await call(exportRoute.GET, `/x?format=markdown`, { id: investigationId }, { cookie: owner.cookie })).text();
    expect(plain).toContain('jane.roe@example.net');
    const redacted = await (await call(exportRoute.GET, `/x?format=markdown&redact=true`, { id: investigationId }, { cookie: owner.cookie })).text();
    expect(redacted).not.toContain('jane.roe@example.net');
  });
});

describe('uploads', () => {
  function upload(kind: string, name: string, data: Buffer, type = 'application/octet-stream') {
    const fd = new FormData();
    fd.set('kind', kind);
    fd.set('file', new File([new Uint8Array(data)], name, { type }));
    return call(artifactsRoute.POST, '/x', { id: investigationId }, { method: 'POST', cookie: owner.cookie, body: fd });
  }

  it('accepts an image, extracts EXIF GPS and OCR text in a background job', async () => {
    const res = await upload('image', 'street.jpg', await makeExifJpeg(), 'image/jpeg');
    expect(res.status).toBe(201);
    expect(await processNextJob(db())).toBe('completed');
    const items = (await json(await call(artifactsRoute.GET, '/x?kind=image', { id: investigationId }, { cookie: owner.cookie }))).items;
    const img = items[0];
    expect(img.status).toBe('processed');
    expect(img.analysis.gps.latitude).toBeCloseTo(38.7223, 3);
    expect(img.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(String(img.analysis.ocr?.text ?? '')).toMatch(/ATLAS/);
  }, 120_000);

  it('rejects duplicates, disguised files and wrong kinds by content, not by name', async () => {
    const dup = await upload('image', 'street-copy.jpg', await makeExifJpeg(), 'image/jpeg');
    expect(dup.status).toBe(409);
    const fake = await upload('image', 'photo.jpg', Buffer.from('#!/bin/sh\necho pwned\n'), 'image/jpeg');
    expect(fake.status).toBe(415);
    const exe = await upload('document', 'report.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]), 'application/pdf');
    expect(exe.status).toBe(415);
    const kind = await upload('script', 'x.txt', Buffer.from('hello'));
    expect(kind.status).toBe(400);
  });

  it('analyses a PDF as untrusted data and ignores embedded instructions', async () => {
    const res = await upload('document', 'memo.pdf', await makePdf(), 'application/pdf');
    expect(res.status).toBe(201);
    expect(await processNextJob(db())).toBe('completed');
    const items = (await json(await call(artifactsRoute.GET, '/x?kind=document', { id: investigationId }, { cookie: owner.cookie }))).items;
    const doc = items.find((d: { originalName: string }) => d.originalName === 'memo.pdf');
    expect(doc.status).toBe('processed');
    expect(doc.analysis.textPreview).toMatch(/ignore (all )?previous instructions/i);
    // The injected instruction is stored as text only — no investigation state was changed by it.
    const inv = await json(await call(investigationRoute.GET, `/api/investigations/${investigationId}`, { id: investigationId }, { cookie: owner.cookie }));
    expect(JSON.stringify(inv)).not.toMatch(/deleted by document/i);
  }, 60_000);

  it('marks a zip bomb disguised as DOCX as failed without expanding it', async () => {
    const res = await upload('document', 'bomb.docx', await makeZipBomb());
    if (res.status === 201) {
      await processNextJob(db());
      const items = (await json(await call(artifactsRoute.GET, '/x?kind=document', { id: investigationId }, { cookie: owner.cookie }))).items;
      const bomb = items.find((d: { originalName: string }) => d.originalName === 'bomb.docx');
      expect(bomb.status).toBe('failed');
      expect(bomb.error).toMatch(/zip bomb|compression|size/i);
    } else {
      expect(res.status).toBe(415);
    }
  }, 60_000);

  it('does not let another user upload into the investigation', async () => {
    const fd = new FormData();
    fd.set('kind', 'image');
    fd.set('file', new File([new Uint8Array(await makeExifJpeg('other'))], 'x.jpg', { type: 'image/jpeg' }));
    const res = await call(artifactsRoute.POST, '/x', { id: investigationId }, { method: 'POST', cookie: intruder.cookie, body: fd });
    expect(res.status).toBe(404);
  });
});

describe('provider configuration status', () => {
  it('reports key presence without ever returning secret values', async () => {
    const before = process.env.SHODAN_API_KEY;
    process.env.SHODAN_API_KEY = 'shodan-secret-value-123456';
    try {
      const { resetEnvCache } = await import('@/server/config/env');
      resetEnvCache();
      const res = await call(providersRoute.GET, '/api/providers', {}, { cookie: owner.cookie });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain('shodan-secret-value-123456');
      const body = JSON.parse(text);
      expect(body.secrets.SHODAN_API_KEY).toBe(true);
      expect(body.secrets.HIBP_API_KEY).toBe(false);
    } finally {
      if (before === undefined) delete process.env.SHODAN_API_KEY;
      else process.env.SHODAN_API_KEY = before;
      (await import('@/server/config/env')).resetEnvCache();
    }
  });
});
