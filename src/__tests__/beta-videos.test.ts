import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBuilder } from './_utils';

const mockFromFn = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  db: { from: mockFromFn },
}));

import { GET as listVideos, POST } from '../pages/api/beta-videos';
import { PATCH } from '../pages/api/beta-videos/[id]';
import { GET as resolveBetaVideo } from '../pages/beta/[id]';
import { signToken } from '../lib/auth';

const ID = 'aaaa0000-0000-0000-0000-000000000001';
const staffToken = () => signToken('parttimer', 'staff');
const adminToken = () => signToken('boss', 'admin');

const validVideo = {
  title: 'The Arete',
  wall: 'Cave',
  route: 'Blue V4',
  description: 'Start on the low blue holds.',
  video_url: 'https://www.youtube.com/watch?v=example',
};

function makeReq(path: string, method: string, body?: unknown, token = staffToken()): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const call = (handler: any, request: Request, id?: string) =>
  handler({ request, params: id ? { id } : {}, url: new URL(request.url) } as any);

beforeEach(() => {
  mockFromFn.mockReset();
  mockFromFn.mockImplementation(() => makeBuilder({ data: null, error: null }));
});

describe('beta video management API', () => {
  it('requires a signed-in user to list videos', async () => {
    const request = new Request('http://localhost/api/beta-videos');
    expect((await call(listVideos, request)).status).toBe(401);
  });

  it('allows staff to list saved videos', async () => {
    mockFromFn.mockImplementation(() => makeBuilder({ data: [{ id: ID, ...validVideo, is_active: true }], error: null }));
    const response = await call(listVideos, makeReq('/api/beta-videos', 'GET'));
    expect(response.status).toBe(200);
    expect((await response.json()).videos).toHaveLength(1);
  });

  it('allows staff to create a QR destination', async () => {
    mockFromFn.mockImplementation(() => makeBuilder({ data: { id: ID, ...validVideo, is_active: true }, error: null }));
    const response = await call(POST, makeReq('/api/beta-videos', 'POST', validVideo));
    expect(response.status).toBe(201);
    expect((await response.json()).video.id).toBe(ID);
  });

  it('rejects non-HTTPS video destinations', async () => {
    const response = await call(POST, makeReq('/api/beta-videos', 'POST', { ...validVideo, video_url: 'javascript:alert(1)' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/HTTPS/);
  });

  it('allows staff to change the current video without changing the QR identity', async () => {
    const newVideoUrl = 'https://www.youtube.com/watch?v=new-route';
    mockFromFn.mockImplementation(() => makeBuilder({ data: { id: ID, ...validVideo, video_url: newVideoUrl }, error: null }));
    const response = await call(PATCH, makeReq(`/api/beta-videos/${ID}`, 'PATCH', { video_url: newVideoUrl }), ID);
    expect(response.status).toBe(200);
    expect((await response.json()).video.id).toBe(ID);
  });

  it('allows staff to archive a QR record', async () => {
    mockFromFn.mockImplementation(() => makeBuilder({ data: { id: ID, is_active: false }, error: null }));
    const response = await call(PATCH, makeReq(`/api/beta-videos/${ID}`, 'PATCH', { is_active: false }), ID);
    expect(response.status).toBe(200);
    expect((await response.json()).video.is_active).toBe(false);
  });

  it('allows admins to manage records with the same API', async () => {
    mockFromFn.mockImplementation(() => makeBuilder({ data: { id: ID, ...validVideo, is_active: true }, error: null }));
    const response = await call(POST, makeReq('/api/beta-videos', 'POST', validVideo, adminToken()));
    expect(response.status).toBe(201);
  });
});

describe('public beta QR resolver', () => {
  it('redirects scans to the currently saved video URL', async () => {
    const currentUrl = 'https://www.youtube.com/watch?v=current';
    mockFromFn.mockImplementation(() => makeBuilder({ data: { video_url: currentUrl }, error: null }));
    const response = await call(resolveBetaVideo, new Request(`https://bbo.example/beta/${ID}`), ID);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(currentUrl);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns unavailable for archived or missing codes', async () => {
    const response = await call(resolveBetaVideo, new Request(`https://bbo.example/beta/${ID}`), ID);
    expect(response.status).toBe(404);
  });

  it('rejects malformed code IDs', async () => {
    const response = await call(resolveBetaVideo, new Request('https://bbo.example/beta/nope'), 'nope');
    expect(response.status).toBe(404);
  });
});
