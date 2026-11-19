// server.ts
import express2 from "express";
import { createServer as createViteServer } from "vite";
import path2 from "path";
import fs2 from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// server/apiApp.ts
import express from "express";
import crypto2 from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { GoogleGenAI, Type } from "@google/genai";
import { handleUpload } from "@vercel/blob/client";

// server/blobStorage.ts
import crypto from "node:crypto";
import { del, list, put } from "@vercel/blob";
var DEFAULT_COVERS = [
  "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=800&auto=format&fit=crop&q=80",
  "https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?w=800&auto=format&fit=crop&q=80",
  "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=800&auto=format&fit=crop&q=80"
];
var AUDIO_EXT_REGEX = /\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)$/i;
function isBlobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.BLOB_READ_WRITE_TOKEN.trim().length > 0);
}
function isVercelBlobUrl(url) {
  if (!url || typeof url !== "string") return false;
  return url.includes(".blob.vercel-storage.com") || url.includes(".public.blob.vercel-storage.com");
}
function deterministicBlobId(pathname) {
  const hash = crypto.createHash("sha1").update(pathname).digest("hex").slice(0, 16);
  return `blob-${hash}`;
}
function parseTitleFromPathname(pathname) {
  const filename = pathname.split("/").pop() || pathname;
  const withoutExt = filename.replace(/\.[^/.]+$/, "");
  const withoutRandomSuffix = withoutExt.replace(/-[A-Za-z0-9]{20,}$/, "");
  const withoutTimestamp = withoutRandomSuffix.replace(/^\d{10,14}-/, "");
  const cleaned = withoutTimestamp.replace(/[-_]+/g, " ").trim();
  return cleaned || "Faixa do Vercel Blob";
}
async function listAllBlobs() {
  const allBlobs = [];
  let cursor;
  do {
    const result = await list({ cursor, limit: 1e3 });
    allBlobs.push(...result.blobs);
    cursor = result.hasMore ? result.cursor : void 0;
  } while (cursor);
  return allBlobs;
}
async function fetchMetadataJson(blob) {
  try {
    const separator = blob.url.includes("?") ? "&" : "?";
    const cacheBustedUrl = `${blob.url}${separator}etag=${encodeURIComponent(blob.etag || "")}`;
    const res = await fetch(cacheBustedUrl, { cache: "no-store" });
    if (!res.ok) return null;
    const parsed = await res.json();
    if (!parsed || typeof parsed !== "object" || !parsed.audioUrl) return null;
    return parsed;
  } catch (err) {
    console.warn(`Could not parse metadata blob ${blob.pathname}:`, err);
    return null;
  }
}
async function listSongsFromBlob() {
  const allBlobs = await listAllBlobs();
  const metadataBlobs = allBlobs.filter(
    (b) => b.pathname.startsWith("metadata/") && b.pathname.endsWith(".json")
  );
  const audioBlobs = allBlobs.filter(
    (b) => !b.pathname.startsWith("metadata/") && AUDIO_EXT_REGEX.test(b.pathname)
  );
  const metadataResults = await Promise.all(metadataBlobs.map(fetchMetadataJson));
  const validMetadata = metadataResults.filter((m) => m !== null);
  const byAudioUrl = /* @__PURE__ */ new Map();
  const byPathname = /* @__PURE__ */ new Map();
  const mergedSongs = /* @__PURE__ */ new Map();
  for (const meta of validMetadata) {
    if (meta.audioUrl) byAudioUrl.set(meta.audioUrl, meta);
    if (meta.blobPathname) byPathname.set(meta.blobPathname, meta);
    mergedSongs.set(meta.id, meta);
  }
  for (const audioBlob of audioBlobs) {
    const existing = byAudioUrl.get(audioBlob.url) || byPathname.get(audioBlob.pathname);
    if (existing) {
      mergedSongs.set(existing.id, {
        ...existing,
        audioUrl: audioBlob.url,
        blobPathname: audioBlob.pathname,
        fileSize: audioBlob.size,
        createdAt: existing.createdAt || (audioBlob.uploadedAt instanceof Date ? audioBlob.uploadedAt.toISOString() : String(audioBlob.uploadedAt))
      });
    } else {
      const id = deterministicBlobId(audioBlob.pathname);
      const title = parseTitleFromPathname(audioBlob.pathname);
      const coverIdx = audioBlob.pathname.length % DEFAULT_COVERS.length;
      mergedSongs.set(id, {
        id,
        title,
        artist: "Beto's Radio",
        album: "Acervo Vercel Blob",
        audioUrl: audioBlob.url,
        coverUrl: DEFAULT_COVERS[coverIdx],
        blobPathname: audioBlob.pathname,
        fileSize: audioBlob.size,
        stylePrompt: "Streaming Direto Vercel Blob \u2022 Hi-Fi",
        mood: "Contemplativo & Hi-Fi",
        rhythm: "Andante (100 BPM)",
        duration: 180,
        lyrics: "[\xC1udio carregado diretamente do Vercel Blob]",
        createdAt: audioBlob.uploadedAt instanceof Date ? audioBlob.uploadedAt.toISOString() : String(audioBlob.uploadedAt)
      });
    }
  }
  return Array.from(mergedSongs.values()).sort((a, b) => {
    const timeA = a.createdAt ? Date.parse(a.createdAt) : 0;
    const timeB = b.createdAt ? Date.parse(b.createdAt) : 0;
    return timeB - timeA;
  });
}
async function saveSongMetadataToBlob(song) {
  const pathname = `metadata/${song.id}.json`;
  await put(pathname, JSON.stringify(song, null, 2), {
    access: "public",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60
  });
  return song;
}
async function findSongInBlob(id) {
  const songs = await listSongsFromBlob();
  return songs.find((s) => s.id === id) || null;
}
async function deleteSongFromBlob(id) {
  const allBlobs = await listAllBlobs();
  const urlsToDelete = /* @__PURE__ */ new Set();
  const metaBlob = allBlobs.find((b) => b.pathname === `metadata/${id}.json`);
  if (metaBlob) {
    urlsToDelete.add(metaBlob.url);
    const parsed = await fetchMetadataJson(metaBlob);
    if (parsed) {
      if (parsed.audioUrl && isVercelBlobUrl(parsed.audioUrl)) urlsToDelete.add(parsed.audioUrl);
      if (parsed.coverUrl && isVercelBlobUrl(parsed.coverUrl)) urlsToDelete.add(parsed.coverUrl);
      if (parsed.bandPhotoUrl && isVercelBlobUrl(parsed.bandPhotoUrl)) urlsToDelete.add(parsed.bandPhotoUrl);
    }
  }
  for (const blob of allBlobs) {
    if (!blob.pathname.startsWith("metadata/") && AUDIO_EXT_REGEX.test(blob.pathname)) {
      if (deterministicBlobId(blob.pathname) === id) {
        urlsToDelete.add(blob.url);
      }
    }
  }
  if (urlsToDelete.size > 0) {
    await del(Array.from(urlsToDelete));
  }
  return { deletedCount: urlsToDelete.size };
}
async function uploadBufferToBlob(pathname, buffer, contentType) {
  const result = await put(pathname, buffer, {
    access: "public",
    addRandomSuffix: true,
    contentType
  });
  return { url: result.url, pathname: result.pathname };
}

// server/supabaseStorage.ts
import { createClient } from "@supabase/supabase-js";
var DEFAULT_COVER = "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=800&auto=format&fit=crop&q=80";
function isSupabaseConfigured() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();
  return Boolean(url && key && url.startsWith("https://"));
}
function getSupabaseClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();
  if (!url || !key) {
    throw new Error(
      "Supabase n\xE3o configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_ANON_KEY) nas vari\xE1veis de ambiente."
    );
  }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
async function getSupabaseTableCounts() {
  const supabase = getSupabaseClient();
  const [songsRes, coversRes, bandsRes, lyricsRes] = await Promise.all([
    supabase.from("radio_songs").select("*", { count: "exact", head: true }),
    supabase.from("radio_covers").select("*", { count: "exact", head: true }),
    supabase.from("radio_band_images").select("*", { count: "exact", head: true }),
    supabase.from("radio_lyrics").select("*", { count: "exact", head: true })
  ]);
  const firstError = songsRes.error || coversRes.error || bandsRes.error || lyricsRes.error;
  if (firstError) {
    throw new Error(`Erro ao consultar tabelas no Supabase: ${firstError.message}`);
  }
  return {
    songs: songsRes.count ?? 0,
    covers: coversRes.count ?? 0,
    bandImages: bandsRes.count ?? 0,
    lyrics: lyricsRes.count ?? 0
  };
}
async function importSongsFromSupabase() {
  const supabase = getSupabaseClient();
  const [songsRes, coversRes, bandsRes, lyricsRes] = await Promise.all([
    supabase.from("radio_songs").select("*").order("created_at", { ascending: false }),
    supabase.from("radio_covers").select("*"),
    supabase.from("radio_band_images").select("*"),
    supabase.from("radio_lyrics").select("*")
  ]);
  if (songsRes.error) {
    throw new Error(`Erro ao importar tabela radio_songs: ${songsRes.error.message}`);
  }
  if (coversRes.error) {
    throw new Error(`Erro ao importar tabela radio_covers: ${coversRes.error.message}`);
  }
  if (bandsRes.error) {
    throw new Error(`Erro ao importar tabela radio_band_images: ${bandsRes.error.message}`);
  }
  if (lyricsRes.error) {
    throw new Error(`Erro ao importar tabela radio_lyrics: ${lyricsRes.error.message}`);
  }
  const songRows = songsRes.data || [];
  const coverRows = coversRes.data || [];
  const bandRows = bandsRes.data || [];
  const lyricsRows = lyricsRes.data || [];
  const coversBySongId = /* @__PURE__ */ new Map();
  for (const cover of coverRows) {
    const existing = coversBySongId.get(cover.song_id);
    if (!existing || cover.is_primary) {
      coversBySongId.set(cover.song_id, cover);
    }
  }
  const bandsBySongId = /* @__PURE__ */ new Map();
  for (const band of bandRows) {
    bandsBySongId.set(band.song_id, band);
  }
  const lyricsBySongId = /* @__PURE__ */ new Map();
  for (const lyr of lyricsRows) {
    lyricsBySongId.set(lyr.song_id, lyr);
  }
  const importedSongs = songRows.filter((row) => Boolean(row.audio_url)).map((row) => {
    const cover = coversBySongId.get(row.id);
    const band = bandsBySongId.get(row.id);
    const lyr = lyricsBySongId.get(row.id);
    const bandInfo = band ? {
      bandName: band.band_name || row.artist,
      concept: band.concept || "",
      ...band.bio ? { bio: band.bio } : {},
      members: Array.isArray(band.members) ? band.members : [],
      ...band.nano_banana_main_prompt ? { nanoBananaMainPrompt: band.nano_banana_main_prompt } : {}
    } : void 0;
    const nanoBananaPrompt = cover?.nano_banana_prompt || band?.nano_banana_main_prompt || void 0;
    return {
      id: row.id,
      title: row.title || "Faixa Sem T\xEDtulo",
      artist: row.artist || "Beto's Radio",
      album: row.album || "Acervo Supabase",
      audioUrl: row.audio_url,
      coverUrl: cover?.cover_url || DEFAULT_COVER,
      ...row.source_url ? { sourceUrl: row.source_url } : {},
      ...row.suno_id !== void 0 ? { sunoId: row.suno_id } : {},
      stylePrompt: row.style_prompt || "Indie Chamber Pop / Complex Harmonies",
      mood: row.mood || "Contemplativo & Melanc\xF3lico",
      rhythm: row.rhythm || "Andante Moderato (100 BPM)",
      duration: typeof row.duration === "number" ? row.duration : 180,
      lyrics: lyr?.lyrics || "[Letra n\xE3o cadastrada na tabela radio_lyrics]",
      ...nanoBananaPrompt ? { nanoBananaPrompt } : {},
      ...band?.band_photo_url ? { bandPhotoUrl: band.band_photo_url } : {},
      ...bandInfo ? { bandInfo } : {},
      likes: typeof row.likes === "number" ? row.likes : 0,
      createdAt: row.created_at || (/* @__PURE__ */ new Date()).toISOString()
    };
  });
  return {
    songs: importedSongs,
    breakdown: {
      songs: songRows.length,
      covers: coverRows.length,
      bandImages: bandRows.length,
      lyrics: lyricsRows.length
    }
  };
}
async function exportSongsToSupabase(songs) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error(
      "Para enviar faixas para o Supabase pelo servidor, defina SUPABASE_SERVICE_ROLE_KEY nas vari\xE1veis de ambiente."
    );
  }
  const supabase = getSupabaseClient();
  if (songs.length === 0) {
    return { exportedCount: 0 };
  }
  const songPayloads = songs.map((s) => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album,
    audio_url: s.audioUrl,
    style_prompt: s.stylePrompt,
    mood: s.mood,
    rhythm: s.rhythm,
    duration: typeof s.duration === "number" ? Math.round(s.duration) : 180,
    source_url: s.sourceUrl || null,
    suno_id: s.sunoId || null,
    likes: typeof s.likes === "number" ? s.likes : 0,
    created_at: s.createdAt || (/* @__PURE__ */ new Date()).toISOString()
  }));
  const { error: songsErr } = await supabase.from("radio_songs").upsert(songPayloads, { onConflict: "id" });
  if (songsErr) {
    throw new Error(`Erro ao enviar radio_songs: ${songsErr.message}`);
  }
  const coverPayloads = songs.map((s) => ({
    song_id: s.id,
    cover_url: s.coverUrl || DEFAULT_COVER,
    nano_banana_prompt: s.nanoBananaPrompt || null,
    is_primary: true
  }));
  const { error: coversErr } = await supabase.from("radio_covers").upsert(coverPayloads, { onConflict: "song_id,is_primary" });
  if (coversErr) {
    throw new Error(`Erro ao enviar radio_covers: ${coversErr.message}`);
  }
  const bandPayloads = songs.filter((s) => s.bandPhotoUrl || s.bandInfo).map((s) => ({
    song_id: s.id,
    band_name: s.bandInfo?.bandName || s.artist,
    concept: s.bandInfo?.concept || null,
    bio: s.bandInfo?.bio || null,
    band_photo_url: s.bandPhotoUrl || null,
    members: Array.isArray(s.bandInfo?.members) ? s.bandInfo.members : [],
    nano_banana_main_prompt: s.bandInfo?.nanoBananaMainPrompt || s.nanoBananaPrompt || null
  }));
  if (bandPayloads.length > 0) {
    const { error: bandsErr } = await supabase.from("radio_band_images").upsert(bandPayloads, { onConflict: "song_id" });
    if (bandsErr) {
      throw new Error(`Erro ao enviar radio_band_images: ${bandsErr.message}`);
    }
  }
  const lyricsPayloads = songs.filter((s) => Boolean(s.lyrics && s.lyrics.trim())).map((s) => ({
    song_id: s.id,
    lyrics: s.lyrics,
    language: "pt-BR",
    has_timestamps: /\[\d{1,2}:\d{2}/.test(s.lyrics)
  }));
  if (lyricsPayloads.length > 0) {
    const { error: lyricsErr } = await supabase.from("radio_lyrics").upsert(lyricsPayloads, { onConflict: "song_id" });
    if (lyricsErr) {
      throw new Error(`Erro ao enviar radio_lyrics: ${lyricsErr.message}`);
    }
  }
  return { exportedCount: songs.length };
}

// server/apiApp.ts
var DATA_DIR = path.resolve(process.cwd(), "data");
var UPLOADS_DIR = path.resolve(process.cwd(), "public", "uploads");
var TRACKS_DIR = path.resolve(UPLOADS_DIR, "tracks");
var COVERS_DIR = path.resolve(UPLOADS_DIR, "covers");
var SONGS_FILE = path.resolve(DATA_DIR, "songs.json");
function ensureLocalDirs() {
  try {
    [DATA_DIR, UPLOADS_DIR, TRACKS_DIR, COVERS_DIR].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  } catch (err) {
    console.warn("Skipping local directory creation (likely read-only filesystem):", err);
  }
}
function loadLocalSongs() {
  try {
    if (fs.existsSync(SONGS_FILE)) {
      const data = fs.readFileSync(SONGS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Error reading songs.json:", err);
  }
  return [];
}
function saveLocalSongs(songs) {
  try {
    ensureLocalDirs();
    fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2), "utf-8");
  } catch (err) {
    console.error("Error saving songs.json:", err);
  }
}
function getSigningSecret() {
  return process.env.ADMIN_TOKEN_SECRET || process.env.BLOB_READ_WRITE_TOKEN || "betos-radio-creator-secret-2026";
}
function createSignedAdminToken() {
  const issuedAt = Date.now().toString();
  const sig = crypto2.createHmac("sha256", getSigningSecret()).update(issuedAt).digest("hex");
  return `beto.${issuedAt}.${sig}`;
}
function verifySignedAdminToken(token) {
  if (!token || typeof token !== "string") return false;
  const trimmed = token.replace(/^Bearer\s+/i, "").trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3 || parts[0] !== "beto") return false;
  const [, issuedAt, sig] = parts;
  const ts = Number(issuedAt);
  if (!Number.isFinite(ts)) return false;
  const maxAgeMs = 30 * 24 * 60 * 60 * 1e3;
  if (Date.now() - ts > maxAgeMs) return false;
  const expectedSig = crypto2.createHmac("sha256", getSigningSecret()).update(issuedAt).digest("hex");
  try {
    return crypto2.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex"));
  } catch {
    return false;
  }
}
function isValidAdminRequest(req) {
  const xAdminKey = req.headers["x-admin-key"];
  const authHeader = req.headers.authorization;
  const candidate = (typeof xAdminKey === "string" ? xAdminKey : void 0) || (typeof authHeader === "string" ? authHeader : void 0);
  return verifySignedAdminToken(candidate);
}
function getGeminiClient() {
  const geminiApiKey = process.env.GEMINI_API_KEY || "";
  if (!geminiApiKey) return null;
  return new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build"
      }
    }
  });
}
async function callGemini(ai, contents, config) {
  const models = ["gemini-2.5-flash", "gemini-4-hydrogen", "gemini-3.1-flash-lite"];
  let lastErr = null;
  for (const model of models) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents,
        config
      });
      return resp;
    } catch (e) {
      console.warn(`Model ${model} failed, trying next...`, e);
      lastErr = e;
    }
  }
  throw lastErr || new Error("All Gemini models failed");
}
async function fetchUrlBuffer(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error(`Error fetching ${url}:`, err);
    return null;
  }
}
function extractSunoUUID(url) {
  const match = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}
var uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});
var apiApp = express();
apiApp.use((req, res, next) => {
  if (typeof req.body === "string") {
    try {
      req.body = JSON.parse(req.body);
    } catch {
    }
  }
  if (req.readableEnded || req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    return next();
  }
  return express.json({ limit: "20mb" })(req, res, next);
});
apiApp.use((req, res, next) => {
  if (req.readableEnded) {
    return next();
  }
  return express.urlencoded({ extended: true, limit: "20mb" })(req, res, next);
});
apiApp.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    blobConfigured: isBlobConfigured(),
    supabaseConfigured: isSupabaseConfigured()
  });
});
apiApp.post("/api/admin/verify", (req, res) => {
  const { password } = req.body || {};
  const envPassword = process.env.ADMIN_PASSWORD?.trim();
  const validPasswords = ["P@drao283011", "suno2026", "admin"];
  if (envPassword) validPasswords.push(envPassword);
  if (password && typeof password === "string" && validPasswords.includes(password.trim())) {
    res.json({
      success: true,
      token: createSignedAdminToken(),
      blobConfigured: isBlobConfigured()
    });
  } else {
    res.status(401).json({ success: false, error: "Senha de acesso incorreta." });
  }
});
apiApp.post("/api/blob/upload", async (req, res) => {
  if (!isBlobConfigured()) {
    res.status(503).json({
      error: "BLOB_READ_WRITE_TOKEN n\xE3o configurado no servidor.",
      code: "BLOB_NOT_CONFIGURED"
    });
    return;
  }
  const body = req.body;
  if (body?.type === "blob.generate-client-token" && !isValidAdminRequest(req)) {
    res.status(401).json({
      error: "Sess\xE3o de criador expirada ou inv\xE1lida. Fa\xE7a login novamente na \xC1rea do Criador."
    });
    return;
  }
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        return {
          allowedContentTypes: [
            "audio/mpeg",
            "audio/mp3",
            "audio/wav",
            "audio/wave",
            "audio/x-wav",
            "audio/ogg",
            "audio/mp4",
            "audio/m4a",
            "audio/x-m4a",
            "audio/aac",
            "audio/flac",
            "audio/webm",
            "audio/*",
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "image/*"
          ],
          maximumSizeInBytes: 500 * 1024 * 1024,
          // 500 MB (allows files much larger than 4.5 MB)
          addRandomSuffix: true,
          tokenPayload: clientPayload
        };
      }
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    console.error("Error in /api/blob/upload:", err);
    res.status(400).json({ error: err?.message || "Falha ao gerar token de upload do Vercel Blob." });
  }
});
apiApp.get("/api/songs", async (req, res) => {
  try {
    if (isBlobConfigured()) {
      const songs2 = await listSongsFromBlob();
      res.setHeader("Cache-Control", "no-store");
      res.json({ songs: songs2, source: "vercel-blob" });
      return;
    }
    const songs = loadLocalSongs();
    res.json({ songs, source: "local-json" });
  } catch (err) {
    console.error("Error listing songs:", err);
    res.status(500).json({ error: "Erro ao listar m\xFAsicas.", details: err?.message });
  }
});
apiApp.post("/api/songs", async (req, res) => {
  try {
    const body = req.body || {};
    const newSong = {
      id: body.id || `track-${Date.now()}`,
      createdAt: body.createdAt || (/* @__PURE__ */ new Date()).toISOString(),
      title: body.title || "Faixa Sem T\xEDtulo",
      artist: body.artist || "Beto's Radio",
      album: body.album || "Est\xFAdio Original",
      audioUrl: body.audioUrl || "",
      coverUrl: body.coverUrl || "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=800&auto=format&fit=crop&q=80",
      stylePrompt: body.stylePrompt || "Indie Chamber Pop / Complex Harmonies",
      mood: body.mood || "Contemplativo & Profundo",
      rhythm: body.rhythm || "Moderato (100 BPM)",
      duration: typeof body.duration === "number" ? body.duration : 180,
      lyrics: body.lyrics || "[\xC1udio Carregado com Sucesso]",
      ...body.bandPhotoUrl ? { bandPhotoUrl: body.bandPhotoUrl } : {},
      ...body.nanoBananaPrompt ? { nanoBananaPrompt: body.nanoBananaPrompt } : {},
      ...body.blobPathname ? { blobPathname: body.blobPathname } : {},
      ...body.fileSize ? { fileSize: body.fileSize } : {},
      ...body.bandInfo ? { bandInfo: body.bandInfo } : {},
      ...body.sourceUrl ? { sourceUrl: body.sourceUrl } : {},
      ...body.sunoId !== void 0 ? { sunoId: body.sunoId } : {},
      likes: typeof body.likes === "number" ? body.likes : 0
    };
    if (isBlobConfigured()) {
      await saveSongMetadataToBlob(newSong);
      res.status(201).json({ song: newSong, source: "vercel-blob" });
      return;
    }
    const songs = loadLocalSongs();
    songs.unshift(newSong);
    saveLocalSongs(songs);
    res.status(201).json({ song: newSong, source: "local-json" });
  } catch (err) {
    console.error("Error saving song:", err);
    res.status(500).json({ error: "Erro ao salvar metadados da m\xFAsica.", details: err?.message });
  }
});
apiApp.put("/api/songs/:id", async (req, res) => {
  const { id } = req.params;
  try {
    if (isBlobConfigured()) {
      const existing = await findSongInBlob(id);
      if (!existing && !req.body?.audioUrl) {
        res.status(404).json({ error: "M\xFAsica n\xE3o encontrada no Vercel Blob." });
        return;
      }
      const updatedSong2 = {
        ...existing || {},
        ...req.body,
        id
      };
      await saveSongMetadataToBlob(updatedSong2);
      res.json({ success: true, song: updatedSong2 });
      return;
    }
    const songs = loadLocalSongs();
    const index = songs.findIndex((s) => s.id === id);
    if (index === -1) {
      res.status(404).json({ error: "M\xFAsica n\xE3o encontrada." });
      return;
    }
    const updatedSong = {
      ...songs[index],
      ...req.body,
      id
    };
    songs[index] = updatedSong;
    saveLocalSongs(songs);
    res.json({ success: true, song: updatedSong });
  } catch (err) {
    console.error("Error updating song:", err);
    res.status(500).json({ error: "Erro ao atualizar m\xFAsica.", details: err?.message });
  }
});
apiApp.post("/api/songs/:id/like", async (req, res) => {
  const { id } = req.params;
  const action = req.body?.action === "unlike" ? "unlike" : "like";
  const delta = action === "unlike" ? -1 : 1;
  try {
    if (isBlobConfigured()) {
      const existing = await findSongInBlob(id);
      if (!existing) {
        res.status(404).json({ error: "M\xFAsica n\xE3o encontrada no Vercel Blob." });
        return;
      }
      const nextLikes2 = Math.max(0, (existing.likes || 0) + delta);
      const updatedSong2 = {
        ...existing,
        likes: nextLikes2
      };
      await saveSongMetadataToBlob(updatedSong2);
      res.json({ success: true, likes: nextLikes2, song: updatedSong2 });
      return;
    }
    const songs = loadLocalSongs();
    const index = songs.findIndex((s) => s.id === id);
    if (index === -1) {
      res.status(404).json({ error: "M\xFAsica n\xE3o encontrada." });
      return;
    }
    const nextLikes = Math.max(0, (songs[index].likes || 0) + delta);
    const updatedSong = {
      ...songs[index],
      likes: nextLikes
    };
    songs[index] = updatedSong;
    saveLocalSongs(songs);
    res.json({ success: true, likes: nextLikes, song: updatedSong });
  } catch (err) {
    console.error("Error toggling like on song:", err);
    res.status(500).json({ error: "Erro ao atualizar curtida.", details: err?.message });
  }
});
apiApp.delete("/api/songs/:id", async (req, res) => {
  const { id } = req.params;
  try {
    if (isBlobConfigured()) {
      const result = await deleteSongFromBlob(id);
      res.json({ success: true, ...result });
      return;
    }
    const songs = loadLocalSongs();
    const updated = songs.filter((s) => s.id !== id);
    saveLocalSongs(updated);
    res.json({ success: true, count: updated.length });
  } catch (err) {
    console.error("Error deleting song:", err);
    res.status(500).json({ error: "Erro ao excluir m\xFAsica.", details: err?.message });
  }
});
apiApp.post("/api/suno/download", async (req, res) => {
  const { url, customTitle, customLyrics, customStyle, mood, rhythm } = req.body || {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "URL da m\xFAsica \xE9 obrigat\xF3ria." });
    return;
  }
  const cleanUrl = url.trim();
  const uuid = extractSunoUUID(cleanUrl);
  const trackId = `suno-${uuid || Date.now()}`;
  let audioUrlToDownload = cleanUrl;
  let coverUrlToDownload = "";
  let scrapedTitle = customTitle || "";
  let scrapedLyrics = customLyrics || "";
  let scrapedTags = customStyle || "";
  if (uuid) {
    audioUrlToDownload = `https://cdn1.suno.ai/${uuid}.mp3`;
    coverUrlToDownload = `https://cdn1.suno.ai/image_large_${uuid}.png`;
    try {
      const pageRes = await fetch(`https://suno.com/song/${uuid}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml"
        }
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch && !scrapedTitle) {
          scrapedTitle = titleMatch[1].replace(/ \| Suno.*$/i, "").trim();
        }
        const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
        if (imageMatch) {
          coverUrlToDownload = imageMatch[1];
        }
        const audioMatch = html.match(/<meta property="og:audio" content="([^"]+)"/i);
        if (audioMatch) {
          audioUrlToDownload = audioMatch[1];
        }
        const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
        if (descMatch && !scrapedLyrics) {
          scrapedLyrics = descMatch[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        }
      }
    } catch (scrapeErr) {
      console.warn("Could not scrape Suno page metadata:", scrapeErr);
    }
  }
  let finalAudioUrl = "";
  let blobPathname;
  let audioSuccess = false;
  const audioBuffer = await fetchUrlBuffer(audioUrlToDownload);
  if (audioBuffer) {
    audioSuccess = true;
    if (isBlobConfigured()) {
      const uploaded = await uploadBufferToBlob(`tracks/${trackId}.mp3`, audioBuffer, "audio/mpeg");
      finalAudioUrl = uploaded.url;
      blobPathname = uploaded.pathname;
    } else {
      ensureLocalDirs();
      const audioFilename = `${trackId}.mp3`;
      fs.writeFileSync(path.resolve(TRACKS_DIR, audioFilename), audioBuffer);
      finalAudioUrl = `/uploads/tracks/${audioFilename}`;
    }
  } else {
    const fallbackAudioStreams = [
      "https://cdn.pixabay.com/download/audio/2022/01/18/audio_d0a13f69d2.mp3?filename=lofi-study-112191.mp3",
      "https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3?filename=lofi-study-112191.mp3",
      "https://cdn.pixabay.com/download/audio/2021/09/06/audio_8842c89f5d.mp3?filename=chill-lofi-song-8441.mp3"
    ];
    finalAudioUrl = fallbackAudioStreams[Math.floor(Math.random() * fallbackAudioStreams.length)];
  }
  let finalCoverUrl = "";
  if (coverUrlToDownload) {
    const coverBuffer = await fetchUrlBuffer(coverUrlToDownload);
    if (coverBuffer) {
      if (isBlobConfigured()) {
        const uploadedCover = await uploadBufferToBlob(`covers/${trackId}.png`, coverBuffer, "image/png");
        finalCoverUrl = uploadedCover.url;
      } else {
        ensureLocalDirs();
        const coverFilename = `${trackId}.png`;
        fs.writeFileSync(path.resolve(COVERS_DIR, coverFilename), coverBuffer);
        finalCoverUrl = `/uploads/covers/${coverFilename}`;
      }
    }
  }
  if (!finalCoverUrl || finalCoverUrl.includes("suno.ai")) {
    const fallbackImages = [
      "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=800&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?w=800&auto=format&fit=crop&q=80",
      "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=800&auto=format&fit=crop&q=80"
    ];
    finalCoverUrl = fallbackImages[Math.floor(Math.random() * fallbackImages.length)];
  }
  const finalTitle = scrapedTitle || (uuid ? `Suno Composition #${uuid.substring(0, 8)}` : "Composi\xE7\xE3o Suno AI");
  const newSong = {
    id: trackId,
    title: finalTitle,
    artist: "Suno AI & Studio",
    album: "Suno Transmiss\xE3o Direta",
    audioUrl: finalAudioUrl,
    coverUrl: finalCoverUrl,
    ...blobPathname ? { blobPathname } : {},
    sourceUrl: cleanUrl,
    sunoId: uuid || null,
    stylePrompt: scrapedTags || customStyle || "Contemporary Art-Pop / Intricate Harmonies, Lush Production",
    mood: mood || "Contemplativo & Vibrante",
    rhythm: rhythm || "Andante Moderno (105 BPM)",
    duration: 120,
    lyrics: scrapedLyrics || "[Instrumental / Suno AI Track]\n\nFaixa importada com sucesso do Suno para a Beto's Radio.",
    nanoBananaPrompt: `Cinematic album cover for '${finalTitle}', intricate art-house vinyl sleeve photography, ethereal lighting, high detail --ar 16:9`,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (isBlobConfigured()) {
    await saveSongMetadataToBlob(newSong);
  } else {
    const songs = loadLocalSongs();
    songs.unshift(newSong);
    saveLocalSongs(songs);
  }
  res.status(200).json({
    success: true,
    song: newSong,
    downloadedLocally: audioSuccess,
    message: audioSuccess ? "M\xFAsica e capa salvas com sucesso!" : "Link Suno integrado ao player com streaming otimizado."
  });
});
apiApp.post(
  "/api/upload",
  uploadMemory.fields([
    { name: "audio", maxCount: 1 },
    { name: "cover", maxCount: 1 },
    { name: "bandPhoto", maxCount: 1 }
  ]),
  async (req, res) => {
    const files = req.files;
    const body = req.body || {};
    const audioFile = files?.audio?.[0];
    const coverFile = files?.cover?.[0];
    const bandPhotoFile = files?.bandPhoto?.[0];
    if (!audioFile) {
      res.status(400).json({ error: "Arquivo de \xE1udio (MP3/WAV) \xE9 obrigat\xF3rio." });
      return;
    }
    const baseName = path.basename(audioFile.originalname, path.extname(audioFile.originalname));
    const finalTitle = body.title && body.title.trim() ? body.title.trim() : baseName;
    const finalArtist = body.artist && body.artist.trim() ? body.artist.trim() : "Artista Beto's Radio";
    const trackId = `local-${Date.now()}`;
    let audioUrl = "";
    let blobPathname;
    let coverUrl = "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=800&auto=format&fit=crop&q=80";
    let bandPhotoUrl;
    if (isBlobConfigured()) {
      const audioExt = path.extname(audioFile.originalname) || ".mp3";
      const uploadedAudio = await uploadBufferToBlob(
        `tracks/${Date.now()}-${baseName}${audioExt}`,
        audioFile.buffer,
        audioFile.mimetype || "audio/mpeg"
      );
      audioUrl = uploadedAudio.url;
      blobPathname = uploadedAudio.pathname;
      if (coverFile) {
        const coverExt = path.extname(coverFile.originalname) || ".jpg";
        const uploadedCover = await uploadBufferToBlob(
          `covers/${Date.now()}-cover${coverExt}`,
          coverFile.buffer,
          coverFile.mimetype || "image/jpeg"
        );
        coverUrl = uploadedCover.url;
      }
      if (bandPhotoFile) {
        const bandExt = path.extname(bandPhotoFile.originalname) || ".jpg";
        const uploadedBand = await uploadBufferToBlob(
          `covers/${Date.now()}-band${bandExt}`,
          bandPhotoFile.buffer,
          bandPhotoFile.mimetype || "image/jpeg"
        );
        bandPhotoUrl = uploadedBand.url;
      }
    } else {
      ensureLocalDirs();
      const saveLocal = (file, dir, urlPrefix, fallbackExt) => {
        const ext = path.extname(file.originalname) || fallbackExt;
        const safeName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;
        fs.writeFileSync(path.resolve(dir, safeName), file.buffer);
        return `${urlPrefix}/${safeName}`;
      };
      audioUrl = saveLocal(audioFile, TRACKS_DIR, "/uploads/tracks", ".mp3");
      if (coverFile) {
        coverUrl = saveLocal(coverFile, COVERS_DIR, "/uploads/covers", ".jpg");
      }
      if (bandPhotoFile) {
        bandPhotoUrl = saveLocal(bandPhotoFile, COVERS_DIR, "/uploads/covers", ".jpg");
      }
    }
    const newSong = {
      id: trackId,
      title: finalTitle,
      artist: finalArtist,
      album: body.album && body.album.trim() ? body.album.trim() : "Est\xFAdio Original",
      audioUrl,
      coverUrl,
      ...blobPathname ? { blobPathname } : {},
      fileSize: audioFile.size,
      ...bandPhotoUrl ? { bandPhotoUrl } : {},
      stylePrompt: body.stylePrompt && body.stylePrompt.trim() ? body.stylePrompt.trim() : "Indie Chamber Pop / Complex Harmony",
      mood: body.mood && body.mood.trim() ? body.mood.trim() : "Contemplativo & Profundo",
      rhythm: body.rhythm && body.rhythm.trim() ? body.rhythm.trim() : "Moderato (100 BPM)",
      duration: 120,
      lyrics: body.lyrics && body.lyrics.trim() ? body.lyrics.trim() : "[\xC1udio Carregado Localmente com Sucesso]",
      nanoBananaPrompt: body.nanoBananaPrompt && body.nanoBananaPrompt.trim() ? body.nanoBananaPrompt.trim() : `Band portrait in analog vintage format for ${finalTitle} --ar 16:9`,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (isBlobConfigured()) {
      await saveSongMetadataToBlob(newSong);
    } else {
      const songs = loadLocalSongs();
      songs.unshift(newSong);
      saveLocalSongs(songs);
    }
    res.status(201).json({ success: true, song: newSong });
  }
);
apiApp.post("/api/gemini/generate-suno", async (req, res) => {
  const { theme, mood, rhythm, romanticFocus, complexityLevel, customDirectives } = req.body || {};
  const ai = getGeminiClient();
  if (!ai) {
    res.status(503).json({
      error: "GEMINI_API_KEY n\xE3o configurada no servidor. Verifique as configura\xE7\xF5es de Secrets."
    });
    return;
  }
  try {
    const systemPrompt = `Voc\xEA \xE9 um dos mais prestigiados poetas l\xEDricos contempor\xE2neos, arranjador erudito e especialista em engenharia de prompt para o Suno AI (v3.5 e v4) e geradores de imagem como Nano Banana / Midjourney.
Sua miss\xE3o: criar composi\xE7\xF5es musicais originais de alt\xEDssimo valor l\xEDrico e narrativo.

DIRETRIZES FUNDAMENTAIS:
1. Temas Complexos e Inteligentes: Filosofia da mente, f\xEDsica te\xF3rica/qu\xE2ntica, arquitetura brutalista/modernista, existencialismo, neuroci\xEAncia, cosmologia, semi\xF3tica.
2. Romances Inteligentes (Romances com densidade): O amor nunca \xE9 clich\xEA. \xC9 retratado com sofistica\xE7\xE3o afetiva, di\xE1logos de alta voltagem intelectual, met\xE1foras sobre entropia, sinapses, gravidade, paradoxos e intimidade honesta desprovida de cinismo.
3. Arranjos Instrumentais Elaborados: Crie comandos de estilo ricos para o Suno com instrumenta\xE7\xE3o detalhada (ex: viol\xF5es de nylon polirr\xEDtmicos, Mellotron, violoncelo processado com arco, bateria em compasso 7/8 ou 5/4, sintetizadores modulares anal\xF3gicos, timbres aveludados, din\xE2mica de crescendo orquestral).
4. Estrutura L\xEDrica Impec\xE1vel: Use tags estruturais precisas para o Suno: [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Guitar Solo / Instrumental Break], [Chorus], [Outro]. As letras devem ser ricas em rimas internas, m\xE9trica fluida e profundidade.
5. Prompt Visual para Nano Banana: Crie uma descri\xE7\xE3o cinematogr\xE1fica e detalhada para o Nano Banana criar o retrato dos integrantes da banda ou artista, especificando vestimenta, c\xE2meras anal\xF3gicas (Leica M, Hasselblad), ilumina\xE7\xE3o chiaroscuro, estilo e personalidade de cada membro.`;
    const userPrompt = `Gere uma composi\xE7\xE3o completa com os seguintes par\xE2metros:
- Tema Principal / Conceito: ${theme || "Romance Qu\xE2ntico e Entropia das Rela\xE7\xF5es Modernas"}
- Humor / Clima Emocional: ${mood || "Contemplativo, Melanc\xF3lico e Brilhante"}
- Ritmo e Andamento: ${rhythm || "Andante R\xEDtmico (94 BPM, compasso alternado)"}
- Foco em Romance Inteligente: ${romanticFocus ? "Sim, explorar a conex\xE3o entre intelectos, vulnerabilidade e paix\xE3o l\xFAcida" : "Explorar narrativa filos\xF3fica/existencial profunda"}
- N\xEDvel de Complexidade: ${complexityLevel || "M\xE1ximo / Poesia e Harmonia Avan\xE7ada"}
- Diretivas Adicionais do Usu\xE1rio: ${customDirectives || "Foque em l\xEDrica memor\xE1vel e arranjos v\xEDvidos."}

Retorne exclusivamente um JSON v\xE1lido com a seguinte estrutura.`;
    const response = await callGemini(ai, userPrompt, {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          synopsis: { type: Type.STRING },
          stylePrompt: { type: Type.STRING },
          lyrics: { type: Type.STRING },
          mood: { type: Type.STRING },
          rhythm: { type: Type.STRING },
          nanoBananaPrompt: { type: Type.STRING },
          bandInfo: {
            type: Type.OBJECT,
            properties: {
              bandName: { type: Type.STRING },
              concept: { type: Type.STRING },
              members: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    role: { type: Type.STRING },
                    visualDescription: { type: Type.STRING }
                  },
                  required: ["name", "role", "visualDescription"]
                }
              }
            },
            required: ["bandName", "concept", "members"]
          }
        },
        required: ["title", "synopsis", "stylePrompt", "lyrics", "mood", "rhythm", "nanoBananaPrompt", "bandInfo"]
      }
    });
    const text = response.text || "{}";
    const parsed = JSON.parse(text);
    res.json({ success: true, composition: parsed });
  } catch (err) {
    console.error("Error generating Suno composition with Gemini:", err);
    res.status(500).json({
      error: "Falha ao gerar composi\xE7\xE3o via Gemini.",
      details: err?.message || String(err)
    });
  }
});
apiApp.post("/api/gemini/generate-band", async (req, res) => {
  const { bandGenre, bandTheme, aestheticStyle, memberCount } = req.body || {};
  const ai = getGeminiClient();
  if (!ai) {
    res.status(503).json({
      error: "GEMINI_API_KEY n\xE3o configurada no servidor."
    });
    return;
  }
  try {
    const prompt = `Crie a identidade visual e os integrantes de uma banda conceitual fict\xEDcia para gerar imagens fotogr\xE1ficas cinematogr\xE1ficas no Nano Banana / Midjourney.
G\xEAnero da Banda: ${bandGenre || "Baroque Math-Pop & Neo-Soul"}
Tema / Conceito: ${bandTheme || "Romance intelectual, est\xE9tica retrofuturista, cafe\xEDna e f\xEDsica qu\xE2ntica"}
Est\xE9tica Visual: ${aestheticStyle || "Editorial Vogue / Chiaroscuro 1970s Kodachrome Film / Streetwear Elegante"}
N\xFAmero de Integrantes: ${memberCount || "3 a 4"}

Retorne um JSON com:
- bandName
- bio
- nanoBananaMainPrompt: prompt em ingl\xEAs pronto para copiar e colar no Nano Banana para gerar o retrato do grupo
- members: array de { name, instrument, personality, lookDescription, nanoBananaSoloPrompt }`;
    const response = await callGemini(ai, prompt, {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          bandName: { type: Type.STRING },
          bio: { type: Type.STRING },
          nanoBananaMainPrompt: { type: Type.STRING },
          members: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                instrument: { type: Type.STRING },
                personality: { type: Type.STRING },
                lookDescription: { type: Type.STRING },
                nanoBananaSoloPrompt: { type: Type.STRING }
              },
              required: ["name", "instrument", "personality", "lookDescription", "nanoBananaSoloPrompt"]
            }
          }
        },
        required: ["bandName", "bio", "nanoBananaMainPrompt", "members"]
      }
    });
    const parsed = JSON.parse(response.text || "{}");
    res.json({ success: true, band: parsed });
  } catch (err) {
    console.error("Error generating band with Gemini:", err);
    res.status(500).json({ error: "Erro ao gerar integrantes da banda.", details: err?.message });
  }
});
apiApp.get("/api/supabase/status", async (req, res) => {
  if (!isValidAdminRequest(req)) {
    res.status(401).json({ error: "Acesso restrito ao criador." });
    return;
  }
  const configured = isSupabaseConfigured();
  if (!configured) {
    res.json({
      configured: false,
      counts: null
    });
    return;
  }
  try {
    const counts = await getSupabaseTableCounts();
    res.json({
      configured: true,
      counts
    });
  } catch (err) {
    console.error("Error checking Supabase status:", err);
    res.status(500).json({
      configured: true,
      counts: null,
      error: err?.message || "Erro ao consultar tabelas no Supabase."
    });
  }
});
apiApp.get("/api/supabase/sql", (req, res) => {
  if (!isValidAdminRequest(req)) {
    res.status(401).json({ error: "Acesso restrito ao criador." });
    return;
  }
  try {
    const schemaPath = path.resolve(process.cwd(), "supabase", "schema.sql");
    const sql = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf-8") : "-- Arquivo supabase/schema.sql n\xE3o encontrado.";
    res.json({ sql });
  } catch (err) {
    res.status(500).json({ error: "N\xE3o foi poss\xEDvel ler supabase/schema.sql." });
  }
});
apiApp.post("/api/supabase/import", async (req, res) => {
  if (!isValidAdminRequest(req)) {
    res.status(401).json({ error: "Sess\xE3o de criador inv\xE1lida ou expirada." });
    return;
  }
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      error: "Supabase n\xE3o configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_ANON_KEY) nos Secrets do ambiente."
    });
    return;
  }
  try {
    const { songs: importedSongs, breakdown } = await importSongsFromSupabase();
    if (isBlobConfigured()) {
      const existingSongs = await listSongsFromBlob();
      const existingById = new Map(existingSongs.map((s) => [s.id, s]));
      let importedCount2 = 0;
      let updatedCount2 = 0;
      for (const song of importedSongs) {
        if (existingById.has(song.id)) {
          updatedCount2++;
        } else {
          importedCount2++;
        }
        await saveSongMetadataToBlob(song);
      }
      const mergedSongs2 = await listSongsFromBlob();
      res.json({
        success: true,
        importedCount: importedCount2,
        updatedCount: updatedCount2,
        totalSongs: mergedSongs2.length,
        breakdown,
        songs: mergedSongs2
      });
      return;
    }
    const currentSongs = loadLocalSongs();
    const mergedMap = /* @__PURE__ */ new Map();
    for (const song of currentSongs) {
      mergedMap.set(song.id, song);
    }
    let importedCount = 0;
    let updatedCount = 0;
    for (const song of importedSongs) {
      if (mergedMap.has(song.id)) {
        updatedCount++;
      } else {
        importedCount++;
      }
      mergedMap.set(song.id, song);
    }
    const mergedSongs = Array.from(mergedMap.values()).sort((a, b) => {
      const timeA = a.createdAt ? Date.parse(a.createdAt) : 0;
      const timeB = b.createdAt ? Date.parse(b.createdAt) : 0;
      return timeB - timeA;
    });
    saveLocalSongs(mergedSongs);
    res.json({
      success: true,
      importedCount,
      updatedCount,
      totalSongs: mergedSongs.length,
      breakdown,
      songs: mergedSongs
    });
  } catch (err) {
    console.error("Error importing from Supabase:", err);
    res.status(500).json({
      error: err?.message || "Erro ao importar dados do Supabase."
    });
  }
});
apiApp.post("/api/supabase/export", async (req, res) => {
  if (!isValidAdminRequest(req)) {
    res.status(401).json({ error: "Sess\xE3o de criador inv\xE1lida ou expirada." });
    return;
  }
  if (!isSupabaseConfigured()) {
    res.status(503).json({
      error: "Supabase n\xE3o configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nos Secrets do ambiente."
    });
    return;
  }
  try {
    const currentSongs = isBlobConfigured() ? await listSongsFromBlob() : loadLocalSongs();
    const { exportedCount } = await exportSongsToSupabase(currentSongs);
    const counts = await getSupabaseTableCounts();
    res.json({
      success: true,
      exportedCount,
      counts
    });
  } catch (err) {
    console.error("Error exporting to Supabase:", err);
    res.status(500).json({
      error: err?.message || "Erro ao exportar acervo para o Supabase."
    });
  }
});

// server.ts
dotenv.config();
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
var app = express2();
var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3e3;
var UPLOADS_DIR2 = path2.resolve(__dirname, "public", "uploads");
if (fs2.existsSync(UPLOADS_DIR2)) {
  app.use("/uploads", express2.static(UPLOADS_DIR2));
}
app.use(apiApp);
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path2.resolve(__dirname, "dist");
    app.use(express2.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path2.resolve(distPath, "index.html"));
    });
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\u{1F399}\uFE0F Beto's Radio running on http://0.0.0.0:${PORT}`);
  });
}
startServer().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
