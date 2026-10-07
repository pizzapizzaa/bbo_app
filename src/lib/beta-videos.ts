export interface BetaVideoFields {
  title: string;
  wall: string;
  route: string;
  description: string;
  video_url: string;
  is_active: boolean;
}

const TEXT_LIMITS: Record<keyof Omit<BetaVideoFields, 'is_active' | 'video_url'>, number> = {
  title: 100,
  wall: 80,
  route: 120,
  description: 500,
};

export function isValidBetaVideoUrl(value: string): boolean {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function parseBetaVideoFields(
  body: unknown,
  partial = false,
): { fields?: Partial<BetaVideoFields>; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request body' };
  }

  const input = body as Record<string, unknown>;
  const fields: Partial<BetaVideoFields> = {};

  for (const key of Object.keys(TEXT_LIMITS) as Array<keyof typeof TEXT_LIMITS>) {
    if (partial && !(key in input)) continue;
    const value = input[key];
    if (typeof value !== 'string') return { error: `${key} must be text` };
    const trimmed = value.trim();
    if (key !== 'description' && !trimmed) return { error: `${key} is required` };
    if (trimmed.length > TEXT_LIMITS[key]) return { error: `${key} is too long` };
    fields[key] = trimmed;
  }

  if (!partial || 'video_url' in input) {
    if (typeof input.video_url !== 'string' || !isValidBetaVideoUrl(input.video_url.trim())) {
      return { error: 'Enter a valid HTTPS video URL' };
    }
    fields.video_url = input.video_url.trim();
  }

  if (!partial || 'is_active' in input) {
    if (input.is_active === undefined && !partial) fields.is_active = true;
    else if (typeof input.is_active !== 'boolean') return { error: 'is_active must be true or false' };
    else fields.is_active = input.is_active;
  }

  if (partial && Object.keys(fields).length === 0) return { error: 'No fields to update' };
  return { fields };
}
