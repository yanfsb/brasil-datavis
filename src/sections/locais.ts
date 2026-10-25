import { aggregateCandidateResults, aggregateZoneResults, buildHeatGrid, contestSummary, type HeatPoint } from "./analysis.ts";
import { candidateAdvantageColor, candidateFlatColor } from "../mapdraw.ts";
import { loadSalvadorPlace, type SalvadorPlaceIndexEntry, type SalvadorPlaceSections, type SalvadorSummary } from "./loadSalvador.ts";

interface Feature {
  readonly properties: { readonly code: string; readonly name: string; readonly votesByCandidate: Readonly<Record<string, number>> };
  readonly geometry: { readonly type: "Polygon" | "MultiPolygon"; readonly coordinates: unknown };
}

interface MapPoint extends HeatPoint {
  readonly longitude: number;
  readonly latitude: number;
}

type Level = "city" | "barrio" | "zone" | "place" | "section";

/** Map-first neighborhood view. The municipal canvas stays mounted behind the dialog. */
export function openLocais(root: HTMLElement, summary: SalvadorSummary, close: () => void,
  loadPlace: (place: SalvadorPlaceIndexEntry) => Promise<SalvadorPlaceSections> = loadSalvadorPlace): void {
  const hasNoAssignedNeighborhoodResults = summary.coverage.assignedPlaces === 0;
  let level: Level = "city";
  let barrio: Feature | null = null;
  let place: SalvadorPlaceIndexEntry | null = null;
  let detail: SalvadorPlaceSections | null = null;
  let detailStatus: "idle" | "loading" | "error" = "idle";
  let mode: "disputa" | "candidatura" | "concentracao" = "disputa";
  let candidateFilter = "todos";
  let browseMode: "bairros" | "zonas" = hasNoAssignedNeighborhoodResults ? "zonas" : "bairros";
  let selectedZone: string | null = null;
  let listFilter = "";
  let viewScale = 1;
  let panX = 0;
  let panY = 0;
  let pointerStart: { id: number; x: number; y: number; panX: number; panY: number; dragged: boolean } | null = null;
  let suppressClick = false;
  const features = summary.neighborhoods.features as Feature[];
  const dialog = document.createElement("section");
  dialog.className = "locais-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "locais-title");
  root.append(dialog);

  const mapPoints: MapPoint[] = summary.places.flatMap((item) => {
    const point = item as SalvadorPlaceIndexEntry & { mapCoordinate?: { longitude: number; latitude: number } | null };
    if (!point.mapCoordinate || !point.coordinate || !point.neighborhoodCode) return [];
    const tallies = point.tallies ?? [];
    const votesByCandidate = Object.fromEntries([...tallies.map((tally) => [tally.candidateNumber, tally.votes] as const),
      ["*", tallies.reduce((sum, tally) => sum + tally.votes, 0)]]);
    return [{ x: point.coordinate.x, y: point.coordinate.y, longitude: point.mapCoordinate.longitude,
      latitude: point.mapCoordinate.latitude, votesByCandidate }];
  });
  const project = mapProjection(features, mapPoints);
  const heatPoints: HeatPoint[] = mapPoints.map(({ x, y, votesByCandidate }) => ({ x, y, votesByCandidate }));
  const zoneResults = aggregateZoneResults(summary.places.map((item) => ({ zone: item.zone, tallies: item.tallies ?? [] })), summary.candidateNumbers);
  const municipalCandidateResults = aggregateCandidateResults(summary.places.map((item) => item.tallies ?? []), summary.candidateNumbers);
  const municipalValidVotes = municipalCandidateResults.reduce((total, tally) => total + tally.votes, 0);
  const candidates = new Map(summary.candidates.map((candidate) => [candidate.number, candidate]));
  const unassignedVotes = Object.values(summary.noGeometryVotesByCode).reduce((sum, count) => sum + count, 0);
  const unassignedPlaces = summary.places.filter((item) => !item.neighborhoodCode).length;
  const missingCoordinates = summary.places.filter((item) => !item.mapCoordinate).length;

  const updateMapTransform = (): void => {
    const world = dialog.querySelector<SVGGElement>(".map-world");
    world?.setAttribute("transform", `translate(${panX} ${panY}) scale(${viewScale})`);
    const zoomLabel = dialog.querySelector<HTMLElement>("[data-zoom-level]");
    if (zoomLabel) zoomLabel.textContent = `${Math.round(viewScale * 100)}%`;
  };

  const zoomAt = (x: number, y: number, factor: number): void => {
    const nextScale = Math.max(1, Math.min(8, viewScale * factor));
    const ratio = nextScale / viewScale;
    panX = x - (x - panX) * ratio;
    panY = y - (y - panY) * ratio;
    viewScale = nextScale;
    updateMapTransform();
  };

  const zoomToNeighborhood = (feature: Feature): void => {
    const shape = [...dialog.querySelectorAll<SVGPathElement>(".bairro-shape")]
      .find((item) => item.dataset.code === feature.properties.code);
    if (!shape) return;
    const bounds = shape.getBBox();
    const extent = Math.max(bounds.width, bounds.height);
    const nextScale = Math.max(1.25, Math.min(5, 420 / Math.max(extent, 1)));
    viewScale = nextScale;
    panX = 300 - (bounds.x + bounds.width / 2) * nextScale;
    panY = 260 - (bounds.y + bounds.height / 2) * nextScale;
    updateMapTransform();
  };

  const chooseNeighborhood = (feature: Feature): void => {
    barrio = feature;
    place = null;
    detail = null;
    level = "barrio";
    browseMode = "bairros";
    selectedZone = null;
    listFilter = "";
    render();
    zoomToNeighborhood(feature);
    dialog.querySelector<HTMLElement>("#locais-browse-title")?.focus();
  };

  const choosePlace = (selected: SalvadorPlaceIndexEntry): void => {
    place = selected;
    detail = null;
    detailStatus = "loading";
    level = "place";
    render();
    void (async () => {
      try {
        const loaded = await loadPlace(selected);
        if (place?.id !== selected.id) return;
        detail = loaded;
        detailStatus = "idle";
        level = "section";
      } catch {
        if (place?.id !== selected.id) return;
        detailStatus = "error";
      }
      render();
    })();
  };

  const render = (): void => {
    const neighborhoodPlaces = summary.places.filter((item) => !barrio || item.neighborhoodCode === barrio.properties.code);
    const query = listFilter.trim().toLocaleLowerCase("pt-BR");
    const selectedCandidate = candidateFilter === "todos" ? summary.candidateNumbers[0] ?? "" : candidateFilter;
    const heatCandidate = candidateFilter === "todos" ? "*" : candidateFilter;
    const featuresMarkup = features.map((feature) => {
      const stats = contestSummary(Object.entries(feature.properties.votesByCandidate)
        .map(([candidateNumber, votes]) => ({ candidateNumber, votes })));
      const selected = barrio?.properties.code === feature.properties.code;
      const featureVotes = feature.properties.votesByCandidate;
      const validVotes = Object.values(featureVotes).reduce((sum, votes) => sum + votes, 0);
      const candidateVotes = featureVotes[selectedCandidate] ?? 0;
      const candidateShare = validVotes ? 100 * candidateVotes / validVotes : 0;
      const fill = mode === "disputa" && stats.leader
        ? candidateAdvantageColor(stats.leader, stats.marginPercentagePoints ?? 0)
        : mode === "candidatura" && selectedCandidate && candidateVotes > 0
          ? candidateAdvantageColor(selectedCandidate, candidateShare) : "#343a46";
      const fillOpacity = mode === "disputa" || mode === "candidatura" ? 0.96 : 0.48;
      const ariaResult = hasNoAssignedNeighborhoodResults ? "sem resultados por bairro: nenhum local foi associado"
        : mode === "candidatura" ? `${candidates.get(selectedCandidate)?.name ?? selectedCandidate}: ${candidateShare.toFixed(1)}% dos votos válidos`
          : `${stats.leader ? `vencedor ${candidates.get(stats.leader)?.name ?? stats.leader}` : "empate/sem votos"}, margem ${stats.marginPercentagePoints?.toFixed(1) ?? "—"} pontos percentuais`;
      return `<path d="${svgPath(feature.geometry, project)}" class="bairro-shape${selected ? " selected" : ""}"
        style="fill:${fill};fill-opacity:${fillOpacity}" fill-rule="evenodd" data-code="${escape(feature.properties.code)}"
        tabindex="0" role="button" aria-label="${escape(feature.properties.name)}: ${escape(ariaResult)}">
        <title>${escape(feature.properties.name)} · ${escape(ariaResult)}</title></path>`;
    }).join("");
    const grid = mode === "concentracao" && heatPoints.length
      ? buildHeatGrid(heatPoints, heatCandidate, pointBounds(heatPoints)) : null;
    const heat = grid ? heatGridMarkup(grid, mapPoints, project) : "";
    const leaders = [...new Set(features.flatMap((feature) => {
      const winner = contestSummary(Object.entries(feature.properties.votesByCandidate)
        .map(([candidateNumber, votes]) => ({ candidateNumber, votes }))).leader;
      return winner ? [winner] : [];
    }))].sort((a, b) => Number(a) - Number(b));
    const candidateInfo = candidates.get(selectedCandidate);
    const candidateGradient = `linear-gradient(90deg,#e8e2d8,${candidateFlatColor(selectedCandidate)})`;
    const legend = mode === "disputa"
      ? hasNoAssignedNeighborhoodResults ? `<span><i class="tie"></i>Sem resultados por bairro · nenhum local associado</span>`
        : `${leaders.map((number) => { const item = candidates.get(number); return `<span><i style="background:${candidateFlatColor(number)}"></i>${escape(item?.name ?? `Candidato ${number}`)} · ${escape(item?.party ?? "")}</span>`; }).join("")}<span><i class="tie"></i>Empate/sem votos</span>`
      : mode === "candidatura"
        ? `<span>0% de ${escape(candidateInfo?.name ?? "candidatura")}</span><i class="heat-scale" style="background:${candidateGradient}"></i><span>100% dos votos válidos</span>`
        : `<span>${candidateFilter === "todos" ? "Menos votos válidos" : `Menos votos de ${escape(candidateInfo?.name ?? "candidatura")}`}</span><i class="heat-scale"></i><span>${candidateFilter === "todos" ? "Mais votos válidos" : `Mais votos de ${escape(candidateInfo?.name ?? "candidatura")}`}</span>`;
    const legendNote = mode === "disputa"
      ? hasNoAssignedNeighborhoodResults ? "Os polígonos oficiais são exibidos sem cores de resultado porque nenhum local de votação correspondeu a um bairro."
        : "O tom da cor indica a margem do vencedor; a legenda lista quem venceu ao menos um bairro. A tabela traz todas as candidaturas."
      : mode === "candidatura"
        ? "A cor indica a parcela dos votos válidos do candidato selecionado em cada bairro."
        : `A concentração mostra votos registrados nos locais atribuídos${candidateFilter === "todos" ? ", somando todas as candidaturas." : ` para ${candidateInfo?.name ?? "a candidatura selecionada"}.`}`;
    const candidateFilterMarkup = mode === "disputa" ? "" : `<label class="locais-candidate-filter"><span>${mode === "candidatura" ? "Candidatura" : "Concentrar"}</span><select data-candidate aria-label="Filtrar por candidatura">${mode === "concentracao" ? `<option value="todos" ${candidateFilter === "todos" ? "selected" : ""}>Todas</option>` : ""}${summary.candidates.map((candidate) => `<option value="${escape(candidate.number)}" ${candidateFilter === candidate.number || (mode === "candidatura" && candidateFilter === "todos" && selectedCandidate === candidate.number) ? "selected" : ""}>${escape(candidate.name)}</option>`).join("")}</select></label>`;
    const municipalCandidatesMarkup = `<details class="locais-city-candidates" open><summary>Votação municipal completa · todas as ${municipalCandidateResults.length} candidaturas</summary><p>${municipalValidVotes.toLocaleString("pt-BR")} votos válidos</p>${municipalCandidateResults.map((tally) => {
      const candidateInfo = candidates.get(tally.candidateNumber);
      const share = municipalValidVotes ? 100 * tally.votes / municipalValidVotes : 0;
      return `<div class="locais-candidate-row"><div><strong>${escape(candidateInfo?.name ?? `Candidato ${tally.candidateNumber}`)}</strong><small>${escape(candidateInfo?.party ?? "")}</small></div><b>${tally.votes.toLocaleString("pt-BR")} <small>${share.toFixed(2)}%</small></b><i><span style="width:${share}%"></span></i></div>`;
    }).join("")}</details>`;

    let list: string;
    if (level === "city" && browseMode === "bairros") {
      const matches = features.filter((item) => !query || item.properties.name.toLocaleLowerCase("pt-BR").includes(query));
      list = query
        ? `${matches.slice(0, 40).map((item) => `<button data-code="${escape(item.properties.code)}">${escape(item.properties.name)}</button>`).join("")}${matches.length > 40 ? `<p class="locais-list-note">Mostrando 40 de ${matches.length}; refine a busca.</p>` : ""}${matches.length === 0 ? `<p class="locais-list-note">Nenhum bairro encontrado.</p>` : ""}`
        : `<p class="locais-list-note">Busque um bairro ou selecione-o diretamente no mapa.</p>`;
    } else if (level === "city") {
      const matches = zoneResults.filter((zone) => !query || zone.zone.includes(query));
      list = matches.map((zone) => {
        const winner = zone.winner ? candidates.get(zone.winner) : null;
        return `<button data-zone="${escape(zone.zone)}"><strong>Zona ${escape(zone.zone)}</strong><small>${winner ? `Venceu ${escape(winner.name)} · ${escape(winner.party)}` : "Empate"} · ${zone.validVotes.toLocaleString("pt-BR")} votos válidos</small></button>`;
      }).join("") || `<p class="locais-list-note">Nenhuma zona encontrada.</p>`;
    } else if (level === "zone") {
      const zone = zoneResults.find((item) => item.zone === selectedZone);
      list = zone ? `<p class="locais-list-note">${zone.validVotes.toLocaleString("pt-BR")} votos válidos · margem ${zone.marginPercentagePoints === null ? "empate/sem disputa" : `${zone.marginPercentagePoints.toFixed(1)} p.p.`}</p>${zone.tallies.map((tally) => {
        const candidateInfo = candidates.get(tally.candidateNumber);
        const share = zone.validVotes ? 100 * tally.votes / zone.validVotes : 0;
        return `<div class="locais-candidate-row"><div><strong>${escape(candidateInfo?.name ?? `Candidato ${tally.candidateNumber}`)}</strong><small>${escape(candidateInfo?.party ?? "")}</small></div><b>${tally.votes.toLocaleString("pt-BR")} <small>${share.toFixed(1)}%</small></b><i><span style="width:${share}%"></span></i></div>`;
      }).join("")}` : `<p class="locais-list-note">Zona eleitoral indisponível.</p>`;
    } else if (level === "barrio") {
      const matches = neighborhoodPlaces.filter((item) => !query
        || (item.name ?? "").toLocaleLowerCase("pt-BR").includes(query)
        || item.placeCode.includes(query));
      list = matches.map((item) => {
        const placeTallies = item.tallies ?? [];
        const summary = contestSummary(placeTallies.map((tally) => ({ candidateNumber: tally.candidateNumber, votes: tally.votes })));
        const winner = summary.leader ? candidates.get(summary.leader) : null;
        return `<button data-place="${escape(item.id)}"><strong>${escape(item.name || `Local ${item.placeCode}`)}</strong><small>${winner ? `Lidera ${escape(winner.name)} · ${escape(winner.party)}` : "Empate"} · Zona ${escape(item.zone)} · ${item.sectionCount} seções${item.coordinateStatus === "missing" ? " · sem coordenada" : ""}</small></button>`;
      }).join("") || `<p class="locais-list-note">Nenhum local encontrado neste bairro.</p>`;
    } else if (level === "place") {
      list = `<p class="locais-loading" role="status"><span aria-hidden="true"></span>${detailStatus === "error" ? "Não foi possível carregar as seções." : "Carregando seções automaticamente…"}</p>${detailStatus === "error" ? `<button data-retry="true">Tentar novamente</button>` : ""}`;
    } else {
      list = (detail?.sections ?? []).map((section) => {
        const valid = summary.candidateNumbers.map((number) => [number, section.votesByCode[number] ?? 0] as const)
          .sort((a, b) => b[1] - a[1]);
        const validVotes = valid.reduce((sum, [, votes]) => sum + votes, 0);
        const special = [["Brancos", section.votesByCode["95"] ?? 0], ["Nulos", section.votesByCode["96"] ?? 0],
          ["Anulados", section.votesByCode["97"] ?? 0], ["Nulos técnicos", section.votesByCode["28"] ?? 0]] as const;
        const total = Object.values(section.votesByCode).reduce((sum, votes) => sum + votes, 0);
        const candidatesMarkup = valid.map(([number, votes]) => {
          const candidateInfo = candidates.get(number);
          const share = validVotes ? 100 * votes / validVotes : 0;
          return `<div class="locais-candidate-row"><div><strong>${escape(candidateInfo?.name ?? `Candidato ${number}`)}</strong><small>${escape(candidateInfo?.party ?? "")}</small></div><b>${votes.toLocaleString("pt-BR")} <small>${share.toFixed(1)}%</small></b><i><span style="width:${share}%"></span></i></div>`;
        }).join("");
        return `<article class="locais-section"><header><strong>Seção ${escape(section.section)}</strong><span>${total.toLocaleString("pt-BR")} comparecimentos</span></header><div class="locais-section-candidates">${candidatesMarkup}</div><small class="locais-special">${special.filter(([, votes]) => votes).map(([label, votes]) => `${label}: ${votes.toLocaleString("pt-BR")}`).join(" · ")}</small></article>`;
      }).join("");
    }

    const browseTitle = level === "city" ? (browseMode === "zonas" ? "Zonas eleitorais" : `Bairros de ${summary.municipality.name}`)
      : level === "zone" ? `Zona eleitoral ${selectedZone ?? ""}`
        : level === "barrio" ? barrio?.properties.name ?? "Locais de votação"
          : level === "place" ? place?.name ?? `Local ${place?.placeCode ?? ""}` : `Seções · ${place?.name ?? `Local ${place?.placeCode ?? ""}`}`;
    const browseSubtitle = level === "zone" ? "Agregação TSE · sem polígonos de zona nesta camada"
      : level === "barrio" ? "IBGE · bairro oficial"
        : level === "place" || level === "section" ? `${place?.sectionCount ?? 0} seções · Zona ${escape(place?.zone ?? "")} · Local ${escape(place?.placeCode ?? "")}`
          : browseMode === "zonas" ? "Resultados agrupados pelos códigos de zona do TSE" : `${features.length} bairros oficiais · IBGE Censo 2022`;
    const detailIntro = level === "section" ? "Votos registrados em cada seção deste local." : level === "barrio"
      ? "Escolha um local; as seções abrem automaticamente." : level === "zone"
        ? "Votos válidos por candidatura nesta zona; os locais sem coordenada continuam incluídos." : level === "city"
          ? browseMode === "zonas" ? "Selecione uma zona para ver vencedora e votos de todas as candidaturas." : "Escolha um bairro no mapa ou pesquise pelo nome." : "";
    const searchLabel = level === "city" ? (browseMode === "zonas" ? "Buscar zona eleitoral" : "Buscar bairro") : "Buscar local neste bairro";
    const filterMarkup = level === "city" || level === "barrio"
      ? `<label class="locais-search"><span class="sr-only">${searchLabel}</span><input type="search" aria-label="${searchLabel}" placeholder="${browseMode === "zonas" && level === "city" ? "Buscar zona…" : level === "city" ? "Buscar bairro…" : "Buscar local…"}" value="${escape(listFilter)}"></label>` : "";
    const browseTabs = level === "city" ? `<div class="locais-browse-tabs" role="group" aria-label="Nível de exploração"><button type="button" data-browse="bairros" aria-pressed="${browseMode === "bairros"}">Bairros</button><button type="button" data-browse="zonas" aria-pressed="${browseMode === "zonas"}">Zonas eleitorais</button></div>` : "";

    const spatialNote = summary.coverage.assignedPlaces === 0
      ? "Há polígonos oficiais, mas nenhum local de votação foi associado a bairro; não há resultados territoriais nesta camada. Explore zonas, locais e seções."
      : summary.geometry?.coordinateCrsAssumption
        ? `Coordenadas dos locais sob hipótese ${summary.geometry.coordinateCrsAssumption.split(" ")[0]}; o TSE não informa datum/referência espacial. Pontos sem correspondência permanecem fora do mapa.`
        : "Votos registrados nos locais de votação — não necessariamente por moradores do bairro.";
    dialog.innerHTML = `<header class="locais-header"><div><p class="locais-kicker">${escape(summary.municipality.name)} · ${escape(summary.municipality.uf)} · ${summary.election.year}</p><h1 id="locais-title">Locais</h1><p>Votos registrados nos locais de votação — não necessariamente por moradores do bairro. ${escape(spatialNote)}</p></div><button type="button" data-close aria-label="Fechar Locais">Fechar</button></header>
      <section class="locais-toolbar" aria-label="Visualização do mapa"><div class="locais-modes" role="group" aria-label="Modo do mapa"><button type="button" data-mode="disputa" aria-pressed="${mode === "disputa"}">Vantagem</button><button type="button" data-mode="candidatura" aria-pressed="${mode === "candidatura"}">Candidatura</button><button type="button" data-mode="concentracao" aria-pressed="${mode === "concentracao"}">Concentração</button></div>${candidateFilterMarkup}<div class="locais-legend" aria-label="Legenda">${legend}</div></section><p class="locais-legend-note">${legendNote}</p>
      <div class="locais-content"><section class="locais-map-panel" aria-label="Mapa de bairros"><div class="locais-map-heading"><strong>${mode === "disputa" ? "Vantagem por bairro" : mode === "candidatura" ? `Votos de ${escape(candidateInfo?.name ?? "candidatura")} por bairro` : `Concentração ${candidateFilter === "todos" ? "de votos válidos" : `de ${escape(candidateInfo?.name ?? "candidatura")}`}`}</strong><span>${mode === "disputa" ? "A cor mostra quem lidera; a intensidade, a margem" : mode === "candidatura" ? "Intensidade da cor = percentual de votos válidos" : "Superfície Gaussiana · raio de 500 m"}</span></div><div class="locais-map-wrap"><svg class="locais-map" viewBox="0 0 600 520" role="img" aria-label="Mapa interativo dos bairros de ${escape(summary.municipality.name)}"><g class="map-world" transform="translate(${panX} ${panY}) scale(${viewScale})">${featuresMarkup}${heat}</g></svg><div class="locais-zoom" role="group" aria-label="Controles do mapa"><button type="button" data-zoom="in" aria-label="Aumentar zoom" title="Aumentar zoom">+</button><span data-zoom-level>${Math.round(viewScale * 100)}%</span><button type="button" data-zoom="out" aria-label="Diminuir zoom" title="Diminuir zoom">−</button><button type="button" data-zoom="reset" aria-label="Recentrar mapa" title="Recentrar mapa">Recentrar</button></div><p class="locais-map-hint">Arraste para mover · use a roda ou os controles para aproximar</p></div><p class="locais-coverage">${unassignedPlaces} locais sem bairro atribuível · ${missingCoordinates} sem coordenadas · ${unassignedVotes.toLocaleString("pt-BR")} votos preservados fora do mapa</p></section>
        <aside class="locais-explorer" aria-label="Explorar bairros e resultados"><div class="locais-explorer-head"><div><h2 id="locais-browse-title" tabindex="-1">${escape(browseTitle)}</h2><p>${browseSubtitle}</p></div>${level !== "city" ? `<button type="button" data-back aria-label="Voltar">Voltar</button>` : ""}</div><p class="locais-explorer-intro">${detailIntro}</p>${browseTabs}${filterMarkup}<div class="locais-results" aria-live="polite">${level === "city" ? municipalCandidatesMarkup : ""}${list}</div>${mode === "concentracao" ? `<p class="locais-footnote">${grid ? `Máximo da escala municipal: ${grid.max.toFixed(2)} votos válidos suavizados.` : "Sem pontos atribuídos para a superfície."} Locais não atribuídos ficam fora do mapa.</p>` : ""}</aside></div>`;

    dialog.querySelectorAll<SVGPathElement>(".bairro-shape").forEach((shape) => {
      shape.addEventListener("click", () => {
        if (suppressClick) { suppressClick = false; return; }
        const feature = features.find((item) => item.properties.code === shape.dataset.code);
        if (feature) chooseNeighborhood(feature);
      });
      shape.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          shape.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
      });
    });
    const candidateSelect = dialog.querySelector<HTMLSelectElement>("[data-candidate]");
    candidateSelect?.addEventListener("change", () => {
      const value = candidateSelect.value;
      if (value === "todos" || summary.candidateNumbers.includes(value)) {
        candidateFilter = value;
        render();
      }
    });
    const search = dialog.querySelector<HTMLInputElement>(".locais-search input");
    search?.addEventListener("input", () => {
      listFilter = search.value;
      const position = search.selectionStart;
      render();
      const nextSearch = dialog.querySelector<HTMLInputElement>(".locais-search input");
      nextSearch?.focus();
      if (position !== null) nextSearch?.setSelectionRange(position, position);
    });
    attachMapInteractions();
  };

  function attachMapInteractions(): void {
    const svg = dialog.querySelector<SVGSVGElement>(".locais-map");
    if (!svg) return;
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const point = svgPoint(svg, event.clientX, event.clientY);
      zoomAt(point.x, point.y, event.deltaY < 0 ? 1.2 : 1 / 1.2);
    }, { passive: false });
    svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY, dragged: false };
      const hitShape = event.target instanceof SVGElement ? event.target.closest<SVGElement>(".bairro-shape") : null;
      (hitShape ?? svg).setPointerCapture(event.pointerId);
      svg.classList.add("is-panning");
    });
    svg.addEventListener("pointermove", (event) => {
      if (!pointerStart || pointerStart.id !== event.pointerId) return;
      const dx = event.clientX - pointerStart.x;
      const dy = event.clientY - pointerStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) pointerStart.dragged = true;
      if (!pointerStart.dragged) return;
      panX = pointerStart.panX + dx * 600 / Math.max(svg.clientWidth, 1);
      panY = pointerStart.panY + dy * 520 / Math.max(svg.clientHeight, 1);
      updateMapTransform();
    });
    const finishPan = (event: PointerEvent): void => {
      if (!pointerStart || pointerStart.id !== event.pointerId) return;
      if (pointerStart.dragged) {
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 0);
      }
      pointerStart = null;
      svg.classList.remove("is-panning");
    };
    svg.addEventListener("pointerup", finishPan);
    svg.addEventListener("pointercancel", finishPan);
  }

  function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number): DOMPoint {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const matrix = svg.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : new DOMPoint(300, 260);
  }

  dialog.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button") : null;
    if (!target) return;
    if (target.hasAttribute("data-close")) { dismiss(); return; }
    if (target.dataset.zoom === "in") { zoomAt(300, 260, 1.35); return; }
    if (target.dataset.zoom === "out") { zoomAt(300, 260, 1 / 1.35); return; }
    if (target.dataset.zoom === "reset") { viewScale = 1; panX = 0; panY = 0; updateMapTransform(); return; }
    if (target.hasAttribute("data-back")) {
      if (level === "section" || level === "place") level = "barrio";
      else { level = "city"; barrio = null; viewScale = 1; panX = 0; panY = 0; }
      detail = null;
      listFilter = "";
      render();
      return;
    }
    if (target.dataset.browse === "bairros" || target.dataset.browse === "zonas") {
      browseMode = target.dataset.browse;
      listFilter = "";
      render();
      dialog.querySelector<HTMLElement>(`[data-browse="${browseMode}"]`)?.focus();
      return;
    }
    if (target.dataset.zone) {
      selectedZone = target.dataset.zone;
      level = "zone";
      listFilter = "";
      render();
      dialog.querySelector<HTMLElement>("#locais-browse-title")?.focus();
      return;
    }
    if (target.dataset.mode === "disputa" || target.dataset.mode === "candidatura" || target.dataset.mode === "concentracao") {
      mode = target.dataset.mode;
      render();
      dialog.querySelector<HTMLElement>(`[data-mode="${mode}"]`)?.focus();
      return;
    }
    if (target.dataset.code) {
      const feature = features.find((item) => item.properties.code === target.dataset.code);
      if (feature) chooseNeighborhood(feature);
      return;
    }
    if (target.dataset.place) {
      const selected = summary.places.find((item) => item.id === target.dataset.place);
      if (selected) choosePlace(selected);
      return;
    }
    if (target.hasAttribute("data-retry") && place) choosePlace(place);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,[tabindex="0"]')]
      .filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const escapeHandler = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (level === "section" || level === "place") level = "barrio";
    else if (level === "barrio" || level === "zone") { level = "city"; barrio = null; viewScale = 1; panX = 0; panY = 0; }
    else { dismiss(); return; }
    detail = null;
    listFilter = "";
    render();
  };
  function dismiss(): void {
    window.removeEventListener("keydown", escapeHandler);
    dialog.remove();
    close();
    root.querySelector<HTMLElement>('[data-action="details"]')?.focus();
  }
  window.addEventListener("keydown", escapeHandler);
  render();
  dialog.querySelector<HTMLElement>("[data-close]")?.focus();

  function svgPath(geometry: Feature["geometry"], projectPoint: (longitude: number, latitude: number) => [number, number]): string {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates as unknown[];
    return polygons.flatMap((polygon) => (polygon as number[][][]).map((ring) => ring.map(([longitude, latitude], index) => {
      const [x, y] = projectPoint(longitude!, latitude!);
      return `${index ? "L" : "M"}${x},${y}`;
    }).join("") + "Z")).join("");
  }

  function mapProjection(mapFeatures: readonly Feature[], points: readonly { longitude: number; latitude: number }[]) {
    const coordinates: [number, number][] = [];
    for (const feature of mapFeatures) {
      const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates as unknown[];
      for (const polygon of polygons) for (const ring of polygon as number[][][]) {
        for (const [longitude, latitude] of ring) coordinates.push([longitude!, latitude!]);
      }
    }
    coordinates.push(...points.map(({ longitude, latitude }) => [longitude, latitude] as [number, number]));
    const latitudes = coordinates.map((point) => point[1]);
    const centerLatitude = (Math.min(...latitudes) + Math.max(...latitudes)) / 2 * Math.PI / 180;
    const projected = coordinates.map(([longitude, latitude]) => [longitude * Math.cos(centerLatitude), latitude] as const);
    const minX = Math.min(...projected.map((point) => point[0])), maxX = Math.max(...projected.map((point) => point[0]));
    const minY = Math.min(...projected.map((point) => point[1])), maxY = Math.max(...projected.map((point) => point[1]));
    const scale = Math.min(560 / (maxX - minX || 1), 480 / (maxY - minY || 1));
    const left = 20 + (560 - (maxX - minX) * scale) / 2;
    const top = 20 + (480 - (maxY - minY) * scale) / 2;
    return (longitude: number, latitude: number): [number, number] => [left + (longitude * Math.cos(centerLatitude) - minX) * scale,
      top + (maxY - latitude) * scale];
  }

  function pointBounds(points: readonly HeatPoint[]) {
    const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
    const padding = 1500;
    return { minX: Math.min(...xs) - padding, minY: Math.min(...ys) - padding,
      maxX: Math.max(...xs) + padding, maxY: Math.max(...ys) + padding, cellSize: 250, bandwidth: 500 };
  }

  function heatGridMarkup(grid: { columns: number; rows: number; cellSize: number; values: readonly number[]; max: number },
    points: readonly MapPoint[], projectPoint: (longitude: number, latitude: number) => [number, number]): string {
    if (!grid.max || !points.length) return "";
    const projectedPoints = points.map((point) => ({ ...point, screen: projectPoint(point.longitude, point.latitude) }));
    const minX = Math.min(...points.map((point) => point.x)), maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y)), maxY = Math.max(...points.map((point) => point.y));
    const minScreenX = Math.min(...projectedPoints.map((point) => point.screen[0])), maxScreenX = Math.max(...projectedPoints.map((point) => point.screen[0]));
    const minScreenY = Math.min(...projectedPoints.map((point) => point.screen[1])), maxScreenY = Math.max(...projectedPoints.map((point) => point.screen[1]));
    const options = pointBounds(points);
    const cells: string[] = [];
    for (let row = 0; row < grid.rows; row += 1) for (let column = 0; column < grid.columns; column += 1) {
      const value = grid.values[row * grid.columns + column] ?? 0;
      if (value < grid.max * 0.06) continue;
      const x = options.minX + (column + 0.5) * grid.cellSize;
      const y = options.minY + (row + 0.5) * grid.cellSize;
      const sx = minScreenX + (x - minX) / (maxX - minX || 1) * (maxScreenX - minScreenX);
      const sy = maxScreenY - (y - minY) / (maxY - minY || 1) * (maxScreenY - minScreenY);
      const sizeX = Math.max(2, grid.cellSize / (maxX - minX || 1) * (maxScreenX - minScreenX));
      const sizeY = Math.max(2, grid.cellSize / (maxY - minY || 1) * (maxScreenY - minScreenY));
      const opacity = 0.12 + 0.68 * value / grid.max;
      cells.push(`<rect x="${sx-sizeX/2}" y="${sy-sizeY/2}" width="${sizeX}" height="${sizeY}" fill="#ff563d" fill-opacity="${opacity}" pointer-events="none"/>`);
    }
    return `<g aria-hidden="true">${cells.join("")}</g>`;
  }

  function escape(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
  }
}
