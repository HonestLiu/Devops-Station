import { create } from "zustand";

import type { Snippet, SnippetSortKey } from "@/lib/types";

/**
 * User-authored terminal snippets (the Snippet sidebar). Persisted in
 * localStorage — a plain front-end store like `useAiStore`, deliberately NOT
 * backed by the Rust/SQLite storage so this feature stays self-contained.
 *
 * The raw `snippets` array keeps insertion order; sorting is applied at read
 * time in the panel (`useMemo`) so re-sorting never rewrites stored data.
 */

const STORAGE_KEY = "user-snippets-v1";
const SORT_KEY = "user-snippets-sort";

const SORT_KEYS: SnippetSortKey[] = ["name", "created", "updated"];

function loadSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Snippet[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return [];
}

function saveSnippets(snippets: Snippet[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snippets));
  } catch {
    /* ignore quota errors */
  }
}

function loadSort(): SnippetSortKey {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw && (SORT_KEYS as string[]).includes(raw)) return raw as SnippetSortKey;
  } catch {
    /* ignore corrupt storage */
  }
  return "updated";
}

interface SnippetState {
  snippets: Snippet[];
  /** Preferred list ordering (persisted). */
  sort: SnippetSortKey;
  /** Insert a snippet or replace one with the same id. */
  upsert: (s: Snippet) => void;
  remove: (id: string) => void;
  setSort: (k: SnippetSortKey) => void;
}

export const useSnippetsStore = create<SnippetState>((set, get) => ({
  snippets: loadSnippets(),
  sort: loadSort(),

  upsert: (s) => {
    const next = [
      ...get().snippets.filter((x) => x.id !== s.id),
      { ...s, updatedAt: Date.now() },
    ];
    set({ snippets: next });
    saveSnippets(next);
  },

  remove: (id) => {
    const next = get().snippets.filter((x) => x.id !== id);
    set({ snippets: next });
    saveSnippets(next);
  },

  setSort: (k) => {
    set({ sort: k });
    try {
      localStorage.setItem(SORT_KEY, k);
    } catch {
      /* ignore quota errors */
    }
  },
}));
