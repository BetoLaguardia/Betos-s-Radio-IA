import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StoredSong } from './blobStorage';

const DEFAULT_COVER =
  'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=800&auto=format&fit=crop&q=80';

interface RadioSongRow {
  id: string;
  title: string;
  artist: string;
  album: string;
  audio_url: string;
  style_prompt?: string | null;
  mood?: string | null;
  rhythm?: string | null;
  duration?: number | null;
  source_url?: string | null;
  suno_id?: string | null;
  likes?: number | null;
  created_at?: string | null;
}

interface RadioCoverRow {
  id: string;
  song_id: string;
  cover_url: string;
  nano_banana_prompt?: string | null;
  is_primary?: boolean | null;
  created_at?: string | null;
}

interface RadioBandImageRow {
  id: string;
  song_id: string;
  band_name: string;
  concept?: string | null;
  bio?: string | null;
  band_photo_url?: string | null;
  members?: any;
  nano_banana_main_prompt?: string | null;
  created_at?: string | null;
}

interface RadioLyricsRow {
  id: string;
  song_id: string;
  lyrics: string;
  language?: string | null;
  has_timestamps?: boolean | null;
  created_at?: string | null;
}

export interface SupabaseTableCounts {
  songs: number;
  covers: number;
  bandImages: number;
  lyrics: number;
}

export function isSupabaseConfigured(): boolean {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();
  return Boolean(url && key && url.startsWith('https://'));
}

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)?.trim();

  if (!url || !key) {
    throw new Error(
      'Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_ANON_KEY) nas variáveis de ambiente.'
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function getSupabaseTableCounts(): Promise<SupabaseTableCounts> {
  const supabase = getSupabaseClient();

  const [songsRes, coversRes, bandsRes, lyricsRes] = await Promise.all([
    supabase.from('radio_songs').select('*', { count: 'exact', head: true }),
    supabase.from('radio_covers').select('*', { count: 'exact', head: true }),
    supabase.from('radio_band_images').select('*', { count: 'exact', head: true }),
    supabase.from('radio_lyrics').select('*', { count: 'exact', head: true }),
  ]);

  const firstError = songsRes.error || coversRes.error || bandsRes.error || lyricsRes.error;
  if (firstError) {
    throw new Error(`Erro ao consultar tabelas no Supabase: ${firstError.message}`);
  }

  return {
    songs: songsRes.count ?? 0,
    covers: coversRes.count ?? 0,
    bandImages: bandsRes.count ?? 0,
    lyrics: lyricsRes.count ?? 0,
  };
}

export async function importSongsFromSupabase(): Promise<{
  songs: StoredSong[];
  breakdown: SupabaseTableCounts;
}> {
  const supabase = getSupabaseClient();

  const [songsRes, coversRes, bandsRes, lyricsRes] = await Promise.all([
    supabase.from('radio_songs').select('*').order('created_at', { ascending: false }),
    supabase.from('radio_covers').select('*'),
    supabase.from('radio_band_images').select('*'),
    supabase.from('radio_lyrics').select('*'),
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

  const songRows = (songsRes.data || []) as RadioSongRow[];
  const coverRows = (coversRes.data || []) as RadioCoverRow[];
  const bandRows = (bandsRes.data || []) as RadioBandImageRow[];
  const lyricsRows = (lyricsRes.data || []) as RadioLyricsRow[];

  const coversBySongId = new Map<string, RadioCoverRow>();
  for (const cover of coverRows) {
    const existing = coversBySongId.get(cover.song_id);
    if (!existing || cover.is_primary) {
      coversBySongId.set(cover.song_id, cover);
    }
  }

  const bandsBySongId = new Map<string, RadioBandImageRow>();
  for (const band of bandRows) {
    bandsBySongId.set(band.song_id, band);
  }

  const lyricsBySongId = new Map<string, RadioLyricsRow>();
  for (const lyr of lyricsRows) {
    lyricsBySongId.set(lyr.song_id, lyr);
  }

  const importedSongs: StoredSong[] = songRows
    .filter((row) => Boolean(row.audio_url))
    .map((row) => {
      const cover = coversBySongId.get(row.id);
      const band = bandsBySongId.get(row.id);
      const lyr = lyricsBySongId.get(row.id);

      const bandInfo = band
        ? {
            bandName: band.band_name || row.artist,
            concept: band.concept || '',
            ...(band.bio ? { bio: band.bio } : {}),
            members: Array.isArray(band.members) ? band.members : [],
            ...(band.nano_banana_main_prompt
              ? { nanoBananaMainPrompt: band.nano_banana_main_prompt }
              : {}),
          }
        : undefined;

      const nanoBananaPrompt =
        cover?.nano_banana_prompt || band?.nano_banana_main_prompt || undefined;

      return {
        id: row.id,
        title: row.title || 'Faixa Sem Título',
        artist: row.artist || "Beto's Radio",
        album: row.album || 'Acervo Supabase',
        audioUrl: row.audio_url,
        coverUrl: cover?.cover_url || DEFAULT_COVER,
        ...(row.source_url ? { sourceUrl: row.source_url } : {}),
        ...(row.suno_id !== undefined ? { sunoId: row.suno_id } : {}),
        stylePrompt: row.style_prompt || 'Indie Chamber Pop / Complex Harmonies',
        mood: row.mood || 'Contemplativo & Melancólico',
        rhythm: row.rhythm || 'Andante Moderato (100 BPM)',
        duration: typeof row.duration === 'number' ? row.duration : 180,
        lyrics: lyr?.lyrics || '[Letra não cadastrada na tabela radio_lyrics]',
        ...(nanoBananaPrompt ? { nanoBananaPrompt } : {}),
        ...(band?.band_photo_url ? { bandPhotoUrl: band.band_photo_url } : {}),
        ...(bandInfo ? { bandInfo } : {}),
        likes: typeof row.likes === 'number' ? row.likes : 0,
        createdAt: row.created_at || new Date().toISOString(),
      };
    });

  return {
    songs: importedSongs,
    breakdown: {
      songs: songRows.length,
      covers: coverRows.length,
      bandImages: bandRows.length,
      lyrics: lyricsRows.length,
    },
  };
}

export async function exportSongsToSupabase(songs: StoredSong[]): Promise<{ exportedCount: number }> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error(
      'Para enviar faixas para o Supabase pelo servidor, defina SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente.'
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
    duration: typeof s.duration === 'number' ? Math.round(s.duration) : 180,
    source_url: s.sourceUrl || null,
    suno_id: s.sunoId || null,
    likes: typeof s.likes === 'number' ? s.likes : 0,
    created_at: s.createdAt || new Date().toISOString(),
  }));

  const { error: songsErr } = await supabase
    .from('radio_songs')
    .upsert(songPayloads, { onConflict: 'id' });
  if (songsErr) {
    throw new Error(`Erro ao enviar radio_songs: ${songsErr.message}`);
  }

  const coverPayloads = songs.map((s) => ({
    song_id: s.id,
    cover_url: s.coverUrl || DEFAULT_COVER,
    nano_banana_prompt: s.nanoBananaPrompt || null,
    is_primary: true,
  }));

  const { error: coversErr } = await supabase
    .from('radio_covers')
    .upsert(coverPayloads, { onConflict: 'song_id,is_primary' });
  if (coversErr) {
    throw new Error(`Erro ao enviar radio_covers: ${coversErr.message}`);
  }

  const bandPayloads = songs
    .filter((s) => s.bandPhotoUrl || s.bandInfo)
    .map((s) => ({
      song_id: s.id,
      band_name: s.bandInfo?.bandName || s.artist,
      concept: s.bandInfo?.concept || null,
      bio: s.bandInfo?.bio || null,
      band_photo_url: s.bandPhotoUrl || null,
      members: Array.isArray(s.bandInfo?.members) ? s.bandInfo.members : [],
      nano_banana_main_prompt: s.bandInfo?.nanoBananaMainPrompt || s.nanoBananaPrompt || null,
    }));

  if (bandPayloads.length > 0) {
    const { error: bandsErr } = await supabase
      .from('radio_band_images')
      .upsert(bandPayloads, { onConflict: 'song_id' });
    if (bandsErr) {
      throw new Error(`Erro ao enviar radio_band_images: ${bandsErr.message}`);
    }
  }

  const lyricsPayloads = songs
    .filter((s) => Boolean(s.lyrics && s.lyrics.trim()))
    .map((s) => ({
      song_id: s.id,
      lyrics: s.lyrics,
      language: 'pt-BR',
      has_timestamps: /\[\d{1,2}:\d{2}/.test(s.lyrics),
    }));

  if (lyricsPayloads.length > 0) {
    const { error: lyricsErr } = await supabase
      .from('radio_lyrics')
      .upsert(lyricsPayloads, { onConflict: 'song_id' });
    if (lyricsErr) {
      throw new Error(`Erro ao enviar radio_lyrics: ${lyricsErr.message}`);
    }
  }

  return { exportedCount: songs.length };
}
