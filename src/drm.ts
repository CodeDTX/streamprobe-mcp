import type { DrmSystem } from "./types.js";

/**
 * DRM system identification.
 *
 * The UUIDs are the one thing HLS and DASH agree on, registered with DASH-IF
 * and stable for years. HLS spells the system as a KEYFORMAT URI and DASH as a
 * ContentProtection@schemeIdUri, and both carry the same UUID inside, so
 * normalising to the UUID means one table serves both.
 *
 * Unrecognised systems are still reported, with `name: null`. A stream
 * protected by something this table has not heard of is a fact worth
 * surfacing, and silently dropping it would read as "no DRM", which is the
 * most misleading answer available.
 */
const SYSTEMS: Record<string, string> = {
  "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": "Widevine",
  "9a04f079-9840-4286-ab92-e65be0885f95": "PlayReady",
  "94ce86fb-07ff-4f43-adb8-93d2fa968ca2": "FairPlay",
  "e2719d58-a985-b3c9-781a-b030af78d30e": "ClearKey",
  "1077efec-c0b2-4d02-ace3-3c1e52e2fb4b": "W3C Common PSSH",
  "f239e769-efa3-4850-9c16-a903c6932efb": "Adobe PrimeTime",
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Pulls a UUID out of a keyformat URI or a schemeIdUri, in any of their forms. */
export function extractSystemId(scheme: string): string | null {
  const match = UUID_RE.exec(scheme);
  return match ? match[0].toLowerCase() : null;
}

export function systemName(systemId: string): string | null {
  return SYSTEMS[systemId.toLowerCase()] ?? null;
}

/**
 * Builds a DrmSystem from an HLS KEYFORMAT or a DASH schemeIdUri.
 *
 * Returns null only for HLS `identity` with no URI, which is the "no
 * encryption" marker rather than a system. `identity` *with* a URI is AES-128,
 * which is real encryption and is reported.
 */
export function identifyDrm(scheme: string, uri?: string, keyId?: string): DrmSystem | null {
  const normalised = scheme.trim().replace(/^"|"$/g, "");

  if (normalised.toLowerCase() === "identity" || normalised === "") {
    if (!uri) return null;
    return {
      systemId: "identity",
      name: "AES-128 (identity)",
      scheme: normalised || "identity",
      keyIds: keyId ? [keyId] : [],
      uri,
    };
  }

  const systemId = extractSystemId(normalised);
  if (!systemId) {
    return {
      systemId: normalised.toLowerCase(),
      name: normalised.includes("appl") ? "FairPlay" : null,
      scheme: normalised,
      keyIds: keyId ? [keyId] : [],
      uri,
    };
  }

  return {
    systemId,
    name: systemName(systemId),
    scheme: normalised,
    keyIds: keyId ? [keyId] : [],
    uri,
  };
}

/** Merges duplicates, which both protocols produce freely across renditions. */
export function dedupeDrm(systems: DrmSystem[]): DrmSystem[] {
  const merged = new Map<string, DrmSystem>();
  for (const system of systems) {
    const existing = merged.get(system.systemId);
    if (!existing) {
      merged.set(system.systemId, { ...system, keyIds: [...new Set(system.keyIds)] });
      continue;
    }
    existing.keyIds = [...new Set([...existing.keyIds, ...system.keyIds])];
    if (!existing.uri && system.uri) existing.uri = system.uri;
  }
  return [...merged.values()];
}
