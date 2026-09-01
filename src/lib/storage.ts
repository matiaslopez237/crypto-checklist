import type { JournalEntry } from "./types";

const JOURNAL_KEY = "crypto-checklist:journal";

export function loadJournal(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as JournalEntry[];
  } catch {
    return [];
  }
}

export function saveJournal(entries: JournalEntry[]): void {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
}

export function addJournalEntry(entry: JournalEntry): JournalEntry[] {
  const entries = [entry, ...loadJournal()];
  saveJournal(entries);
  return entries;
}

export function removeJournalEntry(id: string): JournalEntry[] {
  const entries = loadJournal().filter((e) => e.id !== id);
  saveJournal(entries);
  return entries;
}
