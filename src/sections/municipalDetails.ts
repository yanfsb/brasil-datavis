import { candidateFlatColor } from "../mapdraw.ts";
import type { MunicipalApuracao } from "./loadMunicipality.ts";

export interface MunicipalDetailsCandidate {
  readonly number: string;
  readonly name: string;
  readonly party: string;
}

export function openMunicipalDetails(
  root: HTMLElement,
  municipality: { readonly name: string; readonly uf: string },
  result: MunicipalApuracao,
  candidates: readonly MunicipalDetailsCandidate[],
  close: () => void,
): void {
  let zoneNumber: string | null = null;
  let placeCode: string | null = null;
  let sectionNumber: string | null = null;
  const dialog = document.createElement("section");
  dialog.className = "municipal-details-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", `Detalhes da apuração de ${municipality.name}`);
  root.append(dialog);

  const render = (): void => {
    const zone = result.zones.find((item) => item.number === zoneNumber) ?? null;
    const place = zone?.places.find((item) => item.code === placeCode) ?? null;
    const section = place?.sections.find((item) => item.number === sectionNumber) ?? null;
    const cityVotes = result.candidateVotes;
    const voteRecords = section ? [section.candidateVotes] : place ? place.sections.map((item) => item.candidateVotes) : zone ? [zone.candidateVotes] : [cityVotes];
    const localName = place?.name ? `${place.name} · local ${place.code}` : `Local ${place?.code ?? ""}`;
    const heading = section ? `Seção ${section.number} · ${localName}` : place ? localName : zone ? `Zona eleitoral ${zone.number}` : municipality.name;
    const details = section ? candidateRows(section.candidateVotes, candidates) : candidateRows(sumVotes(voteRecords, candidates), candidates);
    const placeNavigation = zone ? `<h3>Locais de votação</h3><div class="municipal-place-list">${zone.places.map((item) => `<button type="button" data-place="${escapeHtml(item.code)}" aria-pressed="${item.code === placeCode}">${escapeHtml(item.name ?? `Local ${item.code}`)} <small>Local ${escapeHtml(item.code)} · ${item.sections.length} seções</small></button>`).join("")}</div>` : "";
    const sectionNavigation = place ? `<h3>Seções do ${escapeHtml(place.name ?? `local ${place.code}`)}</h3><div class="municipal-section-list">${place.sections.map((item) => `<button type="button" data-section="${escapeHtml(item.number)}" aria-pressed="${item.number === sectionNumber}">Seção ${escapeHtml(item.number)} <small>${item.validVotes.toLocaleString("pt-BR")} votos válidos</small></button>`).join("")}</div>` : "";
    const special = section ? `<p class="fine">${Object.entries(section.specialVotes).map(([code, votes]) => `${specialVoteName(code)} ${votes.toLocaleString("pt-BR")}`).join(" · ") || "Sem votos brancos, nulos ou técnicos registrados nesta seção."}</p>` : "";
    dialog.innerHTML = `<div class="municipal-details-card">
      <header class="municipal-details-head"><div><p class="kicker">${escapeHtml(municipality.uf)} · apuração TSE 2026</p><h2>${escapeHtml(heading)}</h2><p class="fine">${escapeHtml(municipality.name)} · votação registrada no local, não necessariamente de moradores.</p></div><button type="button" data-close aria-label="Fechar detalhes">Fechar</button></header>
      <div class="municipal-details-layout">
        <nav class="municipal-zone-nav" aria-label="Zonas eleitorais"><h3>Zonas eleitorais</h3>${result.zones.map((item) => `<button type="button" data-zone="${escapeHtml(item.number)}" aria-pressed="${item.number === zoneNumber}"><span>Zona ${escapeHtml(item.number)}</span><small>${candidateName(item.winner, candidates)}${item.marginPercentagePoints === null ? "" : ` · margem ${formatNumber(item.marginPercentagePoints, 1)} p.p.`}</small></button>`).join("")}</nav>
        <section class="municipal-details-content"><div class="municipal-details-summary"><strong>${(zone?.validVotes ?? Object.values(cityVotes).reduce((sum, votes) => sum + votes, 0)).toLocaleString("pt-BR")}</strong><span>votos válidos${zone ? ` · ${zone.places.length} locais · ${zone.places.reduce((sum, item) => sum + item.sections.length, 0)} seções` : ` · ${result.zones.length} zonas eleitorais`}</span></div><h3>Votação por candidatura</h3><div class="candidate-list">${details}</div>${special}${placeNavigation}${sectionNavigation}</section>
      </div>
      <footer class="fine">Resultados oficiais por seção do TSE · votos válidos preservados · bairros não são inferidos fora da cobertura oficial.</footer>
      </div>`;
  };

  dialog.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target || !dialog.contains(target)) return;
    if (target.hasAttribute("data-close")) { dismiss(); return; }
    if (target.dataset.zone) { zoneNumber = target.dataset.zone; placeCode = null; sectionNumber = null; render(); return; }
    if (target.dataset.place) { placeCode = target.dataset.place; sectionNumber = null; render(); return; }
    if (target.dataset.section) { sectionNumber = target.dataset.section; render(); }
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const escapeHandler = (event: KeyboardEvent): void => { if (event.key === "Escape") dismiss(); };
  function dismiss(): void {
    window.removeEventListener("keydown", escapeHandler);
    dialog.remove();
    close();
    root.querySelector<HTMLElement>('[data-action="details"]')?.focus();
  }
  window.addEventListener("keydown", escapeHandler);
  render();
  dialog.querySelector<HTMLElement>("[data-close]")?.focus();
}

function candidateRows(votes: Readonly<Record<string, number>>, candidates: readonly MunicipalDetailsCandidate[]): string {
  const total = Object.values(votes).reduce((sum, value) => sum + value, 0);
  return [...candidates].sort((a, b) => (votes[b.number] ?? 0) - (votes[a.number] ?? 0)).map((candidate) => {
    const amount = votes[candidate.number] ?? 0;
    const share = total ? 100 * amount / total : 0;
    return `<article class="candidate-row"><div class="candidate-row-head"><span><i style="background:${candidateFlatColor(candidate.number)}"></i><b>${escapeHtml(candidate.name)}</b><small>${escapeHtml(candidate.party)}</small></span><strong>${amount.toLocaleString("pt-BR")} <small>${formatNumber(share, 1)}%</small></strong></div><div class="candidate-track"><i style="width:${Math.min(100, share)}%;background:${candidateFlatColor(candidate.number)}"></i></div></article>`;
  }).join("");
}

function sumVotes(records: readonly Readonly<Record<string, number>>[], candidates: readonly MunicipalDetailsCandidate[]): Record<string, number> {
  const total: Record<string, number> = Object.fromEntries(candidates.map((candidate) => [candidate.number, 0]));
  for (const record of records) for (const candidate of candidates) total[candidate.number] += record[candidate.number] ?? 0;
  return total;
}

function candidateName(number: string | null, candidates: readonly MunicipalDetailsCandidate[]): string {
  if (!number) return "Empate";
  return candidates.find((candidate) => candidate.number === number)?.name ?? `Candidatura ${number}`;
}

function specialVoteName(code: string): string {
  return ({ "28": "Técnicos", "95": "Brancos", "96": "Nulos", "97": "Anulados" } as Readonly<Record<string, string>>)[code] ?? `Código ${code}`;
}

function formatNumber(value: number, digits: number): string {
  return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}
