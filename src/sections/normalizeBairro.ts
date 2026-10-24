export interface NeighborhoodName {
  /** Aggregation key: trimmed, inner whitespace collapsed, uppercased. */
  readonly key: string;
  /** Original label, unchanged, for display. */
  readonly label: string;
}

/**
 * Key used to group free-text DS_BAIRRO values.
 * Accents and punctuation stay, so "São João" and "SAO JOAO" remain distinct.
 */
export function normalizeBairro(label: string): NeighborhoodName {
  const key = label.trim().replace(/\s+/g, " ").toUpperCase();
  return { key, label };
}
