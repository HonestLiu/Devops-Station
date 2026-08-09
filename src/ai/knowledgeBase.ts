import { kb } from "@/lib/api";
import { useAppStore } from "@/store/useAppStore";

/**
 * A small, dependency-free local knowledge base.
 *
 * - Backend (`kb_scan`) enumerates + reads text files under the chosen root.
 * - Frontend chunks the files and builds an in-memory keyword (BM25-lite) index.
 * - At query time we retrieve the top-k chunks and return them as a context block
 *   that the AI prompts can inject. No embeddings, no network — fully local.
 */

interface Chunk {
  id: number;
  file: string;
  text: string;
  terms: Map<string, number>;
}

interface Index {
  chunks: Chunk[];
  df: Map<string, number>;
  total: number;
}

let index: Index | null = null;
let loadedRoot = "";
let loading: Promise<void> | null = null;

const STOP = new Set(
  "the a an and or of to in on for with is are was were be been it this that as at by from we you they i he she but if then else do does not no yes".split(
    " ",
  ),
);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9一-鿿]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );
}

function chunkText(name: string, content: string, out: Chunk[], startId: number): number {
  let id = startId;
  const paragraphs = content.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const clean = p.trim();
    if (!clean) continue;
    // Split long paragraphs into ~500-char windows so retrieval is granular.
    if (clean.length <= 600) {
      out.push(makeChunk(id++, name, clean));
    } else {
      for (let i = 0; i < clean.length; i += 500) {
        const slice = clean.slice(i, i + 500).trim();
        if (slice) out.push(makeChunk(id++, name, slice));
      }
    }
  }
  return id;
}

function makeChunk(id: number, file: string, text: string): Chunk {
  const terms = new Map<string, number>();
  for (const t of tokenize(text)) terms.set(t, (terms.get(t) ?? 0) + 1);
  return { id, file, text, terms };
}

/** Build (or rebuild) the index from the configured knowledge-base root. */
export async function loadKnowledgeBase(): Promise<void> {
  const settings = useAppStore.getState().settings.ai;
  const root = settings.knowledgeBasePath?.trim();
  if (!root) {
    index = null;
    loadedRoot = "";
    return;
  }
  if (loading) return loading;

  loading = (async () => {
    const files = await kb.scan(root);
    const chunks: Chunk[] = [];
    let id = 0;
    for (const f of files) id = chunkText(f.name, f.content, chunks, id);

    const df = new Map<string, number>();
    for (const c of chunks) {
      for (const term of c.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    }
    index = { chunks, df, total: chunks.length };
    loadedRoot = root;
    loading = null;
  })().catch((e) => {
    loading = null;
    throw e;
  });

  return loading;
}

export function isKbEnabled(): boolean {
  const s = useAppStore.getState().settings.ai;
  return !!s.useKnowledgeBase && !!s.knowledgeBasePath?.trim();
}

export function kbLoaded(): boolean {
  const s = useAppStore.getState().settings.ai;
  return !!index && loadedRoot === s.knowledgeBasePath?.trim();
}

export function kbChunkCount(): number {
  return index?.total ?? 0;
}

/** Score chunks against the query with a BM25-lite formula; return top-k. */
function retrieve(query: string, k = 4): Chunk[] {
  if (!index) return [];
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return [];
  const scores = new Map<number, number>();
  const N = index.total || 1;
  for (const term of qTerms) {
    const df = index.df.get(term) ?? 0;
    if (df === 0) continue;
    const idf = 1 + Math.log(N / (df + 1));
    for (const c of index.chunks) {
      const tf = c.terms.get(term);
      if (!tf) continue;
      const lenNorm = 1 / Math.sqrt(c.text.length);
      scores.set(c.id, (scores.get(c.id) ?? 0) + tf * idf * lenNorm);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => index!.chunks.find((c) => c.id === id)!)
    .filter(Boolean);
}

/** Build a context block from the KB for a given query, or "" if disabled/empty. */
export function buildKbContext(query: string): string {
  if (!isKbEnabled() || !kbLoaded()) return "";
  const chunks = retrieve(query, 4);
  if (chunks.length === 0) return "";
  const body = chunks
    .map((c) => `### From: ${c.file}\n${c.text}`)
    .join("\n\n");
  return (
    "The following extracts from the local knowledge base may be relevant:\n\n" +
    body +
    "\n\nUse them when they help. If they are not relevant, ignore them."
  );
}
