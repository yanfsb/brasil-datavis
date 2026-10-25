import { sectionLayerReady } from "./sections/loadTile.ts";
import { loadSalvadorSummary } from "./sections/loadSalvador.ts";
import { loadMunicipalityApuracao } from "./sections/loadMunicipality.ts";
import { loadNeighborhoodSummary } from "./sections/loadNeighborhood.ts";
import { openMunicipalDetails } from "./sections/municipalDetails.ts";
import { openLocais } from "./sections/locais.ts";
import { correlationSentence, formatNumber, pearson } from "./stats.ts";
import {
  candidateAdvantageColor,
  candidateFlatColor,
  buildSpatialGrid,
  contains,
  fitView,
  flatPartyColor,
  indicatorColor,
  intersectsView,
  overscanView,
  pointInRing,
  querySpatialGrid,
  ringBBox,
  screenTransform,
  stateOutlineWidth,
  zoomAt,
  type BBox,
  type Leader,
  type SpatialGrid,
} from "./mapdraw.ts";

interface Candidate {
  readonly number: string;
  readonly name: string;
  readonly party: string;
  readonly nationalVotes: number;
  readonly nationalPercent: number;
}

interface CandidateResult {
  readonly number: string;
  readonly name: string;
  readonly party: string;
  readonly votes: number;
}

interface Mun {
  readonly ibge: string;
  readonly nome: string;
  readonly uf: string;
  readonly fp: number;
  readonly lp: number;
  readonly fv: number;
  readonly lv: number;
  readonly vv: number;
  readonly ap: number;
  readonly ab: number;
  readonly analfabetismo: number | null;
  readonly esgoto: number | null;
  readonly agua?: number | null;
  readonly lixo?: number | null;
  readonly internet?: number | null;
  readonly renda: number | null;
  readonly pib?: number | null;
  readonly densidade?: number | null;
  readonly populacao?: number | null;
  readonly brancos?: number | null;
  readonly nulos?: number | null;
  readonly urbano?: number | null;
  readonly idosos?: number | null;
  readonly agro?: number | null;
  readonly industria?: number | null;
  readonly lula22?: number | null;
  readonly pl22?: number | null;
  readonly oscilacao?: number | null;
  readonly oscilacaopl?: number | null;
  readonly candidatos?: readonly CandidateResult[];
  readonly apuracaoDetalhe?: string;
  readonly neighborhoodLayer?: string;
  readonly votosValidosEA20?: number;
  readonly g: readonly (readonly (readonly number[])[])[];
}

interface MapFile {
  readonly fonte?: string;
  readonly width: number;
  readonly height: number;
  readonly brasil: { readonly fp: number; readonly lp: number; readonly fv: number; readonly lv: number; readonly vv: number; readonly ap: number; readonly ab: number; readonly brancos?: number; readonly nulos?: number; readonly candidatos?: readonly Candidate[] };
  readonly candidatos?: readonly Candidate[];
  readonly votosForaMunicipios?: Readonly<Record<string, number>>;
  readonly discrepanciasEA20?: readonly { readonly ibge: string; readonly ea20ValidVotes: number; readonly sectionValidVotes: number; readonly difference: number }[];
  readonly ufIndicadores: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly mun: readonly Mun[];
  readonly estados?: readonly { readonly ibge: string; readonly g: Mun["g"] }[];
}

interface Drawable {
  readonly mun: Mun;
  readonly path: Path2D;
  readonly box: BBox;
  readonly leader: Leader;
  readonly margem: number;
  readonly winnerShare: number;
  fills: Record<string, string>;
}

const INDICATORS = [
  { id: "analfabetismo", nome: "Analfabetismo", unidade: "%", ano: "Censo 2022" },
  { id: "esgoto", nome: "Esgoto", unidade: "%", ano: "Censo 2022" },
  { id: "agua", nome: "Água da rede", unidade: "%", ano: "Censo 2022" },
  { id: "lixo", nome: "Lixo coletado", unidade: "%", ano: "Censo 2022" },
  { id: "internet", nome: "Internet", unidade: "%", ano: "Censo 2022" },
  { id: "renda", nome: "Renda", unidade: "R$", ano: "Censo 2022" },
  { id: "pib", nome: "PIB per capita", unidade: "R$", ano: "2023" },
  { id: "densidade", nome: "Densidade", unidade: "hab/km²", ano: "Censo 2022" },
  { id: "abstencao", nome: "Abstenção", unidade: "%", ano: "TSE 2026" },
  { id: "brancos", nome: "Brancos", unidade: "%", ano: "TSE 2026" },
  { id: "nulos", nome: "Nulos", unidade: "%", ano: "TSE 2026" },
  { id: "oscilacao", nome: "Lula 2026 − 2022", unidade: "p.p.", ano: "1º turno" },
  { id: "oscilacaopl", nome: "PL 2026 − 2022", unidade: "p.p.", ano: "Flávio − Bolsonaro" },
  { id: "urbano", nome: "População urbana", unidade: "%", ano: "Censo 2022" },
  { id: "idosos", nome: "60 anos ou mais", unidade: "%", ano: "Censo 2022" },
  { id: "agro", nome: "Agro no PIB", unidade: "%", ano: "IBGE 2021" },
  { id: "industria", nome: "Indústria no PIB", unidade: "%", ano: "IBGE 2021" },
] as const;

type IndicatorId = (typeof INDICATORS)[number]["id"];
type Mode = "municipios" | "estados" | "vantagem" | IndicatorId;

const REGIAO: Readonly<Record<string, string>> = {
  AC: "Norte", AM: "Norte", AP: "Norte", PA: "Norte", RO: "Norte", RR: "Norte", TO: "Norte",
  AL: "Nordeste", BA: "Nordeste", CE: "Nordeste", MA: "Nordeste", PB: "Nordeste", PE: "Nordeste", PI: "Nordeste", RN: "Nordeste", SE: "Nordeste",
  DF: "Centro-Oeste", GO: "Centro-Oeste", MT: "Centro-Oeste", MS: "Centro-Oeste",
  ES: "Sudeste", MG: "Sudeste", RJ: "Sudeste", SP: "Sudeste",
  PR: "Sul", RS: "Sul", SC: "Sul",
};

const app = document.querySelector("#app");
if (!(app instanceof HTMLElement)) throw new Error("missing app root");

void boot(app);

async function boot(root: HTMLElement): Promise<void> {
  try {
    const response = await fetch("/data/map.json");
    if (!response.ok) throw new Error("O mapa municipal ainda não foi gerado. Rode python3 scripts/build_map.py.");
    mount(root, (await response.json()) as MapFile);
  } catch (error) {
    root.textContent = error instanceof Error ? error.message : "Falha ao abrir o mapa.";
  }
}

function mount(root: HTMLElement, data: MapFile): void {
  const drawables = data.mun.map(toDrawable);
  const statePaths = (data.estados ?? []).map((state) => toPath(state.g));
  const byUf = aggregate(drawables);
  const ranges = Object.fromEntries(INDICATORS.map((item) => [item.id, extent(drawables, item.id)])) as Record<IndicatorId, [number, number]>;
  assignFills(drawables, byUf, ranges);
  const grid = buildSpatialGrid(drawables, 220);
  const candidates = data.candidatos ?? data.brasil.candidatos ?? [];
  const counts: Record<string, number> = Object.fromEntries(candidates.map((candidate) => [candidate.number, 0]));
  for (const item of drawables) if (item.leader !== "empate") counts[item.leader] = (counts[item.leader] ?? 0) + 1;
  let voteMode: "municipios" | "estados" | "vantagem" = "municipios";
  let indicator: IndicatorId | null = null;
  const currentMode = (): Mode => indicator ?? voteMode;
  let selected: Drawable | null = null;
  let hovered: Drawable | null = null;
  let query = "";
  const view = fitView(data.width, data.height, window.innerWidth, window.innerHeight, { top: 88, right: 16, bottom: 72, left: 16 });
  let framedByUser = false;
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;

  root.innerHTML = shell();
  const stage = required("#stage");
  const base = requiredCanvas("#base");
  const overlay = requiredCanvas("#overlay");
  const baseCtx = base.getContext("2d");
  const overlayCtx = overlay.getContext("2d");
  if (!baseCtx || !overlayCtx) throw new Error("canvas indisponível");

  const cache = document.createElement("canvas");
  const overview = document.createElement("canvas");
  const cacheCtx = cache.getContext("2d");
  const overviewCtx = overview.getContext("2d");
  if (!cacheCtx || !overviewCtx) throw new Error("canvas indisponível");
  let sharp: { scale: number; panX: number; panY: number; dpr: number } | null = null;
  let overviewScale = 1;
  let overviewMode: Mode | null = null;
  let settle = 0;
  let fastQueued = false;
  let dim = 0;
  let dimTarget = 0;
  let dimFrame = 0;

  const resize = (): void => {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of [base, overlay]) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    if (!framedByUser) Object.assign(view, countryView());
    stage.style.setProperty("--dock-h", `${stage.querySelector("#dock")?.getBoundingClientRect().height ?? 0}px`);
    overviewMode = null;
    sharp = null;
    paintSharp();
  };

  const ensureOverview = (): void => {
    const mode = currentMode();
    if (overviewMode === mode && overview.width > 0) return;
    const longSide = 1280;
    overviewScale = longSide / Math.max(data.width, data.height);
    overview.width = Math.max(1, Math.ceil(data.width * overviewScale));
    overview.height = Math.max(1, Math.ceil(data.height * overviewScale));
    const countryScale = overviewScale;
    paint(
      overviewCtx,
      drawables,
      statePaths,
      byUf,
      mode,
      overview.width,
      overview.height,
      1,
      { scale: overviewScale, panX: 0, panY: 0 },
      countryScale,
    );
    overviewMode = mode;
  };
  const paintSharp = (): void => {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    ensureOverview();
    const frame = overscanView(view, rect.width, rect.height, 0.6);
    const cacheW = Math.max(1, Math.round(frame.width * dpr));
    const cacheH = Math.max(1, Math.round(frame.height * dpr));
    if (cache.width !== cacheW || cache.height !== cacheH) {
      cache.width = cacheW;
      cache.height = cacheH;
    }
    const countryScale = fitView(data.width, data.height, rect.width, rect.height, mapInset(stage)).scale;
    paint(cacheCtx, drawables, statePaths, byUf, currentMode(), frame.width, frame.height, dpr, frame, countryScale);
    sharp = { scale: frame.scale, panX: frame.panX, panY: frame.panY, dpr };
    paintComposed();
  };
  const paintComposed = (): void => {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    base.width = base.width;
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.fillStyle = "#0c0e13";
    baseCtx.fillRect(0, 0, base.width, base.height);
    if (overview.width > 0) {
      const cover = view.scale / overviewScale;
      baseCtx.imageSmoothingEnabled = true;
      baseCtx.setTransform(cover * dpr, 0, 0, cover * dpr, view.panX * dpr, view.panY * dpr);
      baseCtx.drawImage(overview, 0, 0);
    }
    if (sharp && sharp.dpr === dpr && cache.width > 0) {
      const mapped = screenTransform(sharp, view);
      baseCtx.imageSmoothingEnabled = mapped.scale !== 1;
      baseCtx.setTransform(mapped.scale, 0, 0, mapped.scale, mapped.x * dpr, mapped.y * dpr);
      baseCtx.drawImage(cache, 0, 0);
    }
    drawOverlay();
  };
  const paintFast = (): void => {
    if (!sharp || sharp.dpr !== (window.devicePixelRatio || 1) || overviewMode !== currentMode()) {
      paintSharp();
      return;
    }
    paintComposed();
  };
  const drawOverlay = (): void => {
    const rect = stage.getBoundingClientRect();
    paintHighlight(
      overlayCtx,
      selected,
      hovered,
      rect.width,
      rect.height,
      window.devicePixelRatio || 1,
      view,
      dim,
      selected ? selected.fills[currentMode()] ?? null : null,
    );
  };
  const animateDim = (): void => {
    window.cancelAnimationFrame(dimFrame);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = (): void => {
      dim += (dimTarget - dim) * (reduced ? 1 : 0.22);
      if (Math.abs(dimTarget - dim) < 0.015) dim = dimTarget;
      drawOverlay();
      if (dim !== dimTarget) dimFrame = window.requestAnimationFrame(step);
    };
    dimFrame = window.requestAnimationFrame(step);
  };
  const requestFast = (): void => {
    if (fastQueued) return;
    fastQueued = true;
    requestAnimationFrame(() => {
      fastQueued = false;
      paintFast();
    });
  };
  const settleSharp = (): void => {
    window.clearTimeout(settle);
    settle = window.setTimeout(() => paintSharp(), 90);
  };

  const renderPanels = (): void => {
    required("#left-panel").innerHTML = selected ? placePanel(selected.mun, data) : countryPanel(data, counts);
    const mode = currentMode();
    required("#right-panel").innerHTML = indicatorMode(mode) ? correlationPanel(data, drawables, mode, selected) : regionPanel(byUf, candidates);
    required("#legend").innerHTML = legend(mode, counts, ranges, candidates);
    required("#status").textContent = `${formatNumber(data.brasil.ap, 0)}% das seções · ${drawables.length.toLocaleString("pt-BR")} municípios`;
    const results = required("#search-results");
    const matches = search(drawables, query);
    results.hidden = query.length < 2 || matches.length === 0;
    results.innerHTML = matches.map((item) => `<button type="button" data-action="pick" data-ibge="${item.mun.ibge}">${escapeHtml(item.mun.nome)}<span>${item.mun.uf}</span></button>`).join("");
    document.querySelectorAll("[data-action='vote']").forEach((button) => {
      button.setAttribute("aria-pressed", String(indicator === null && button.getAttribute("data-mode") === voteMode));
    });
  };

  const locate = (x: number, y: number): Drawable | null => hit(grid, x, y);
  const pulseMap = (): void => {
    base.classList.remove("is-settling");
    void base.offsetWidth;
    base.classList.add("is-settling");
  };
  const syncSelection = (): void => {
    dimTarget = selected ? 0.62 : 0;
    animateDim();
  };
  const pick = (item: Drawable | null, focus: boolean): void => {
    selected = item;
    syncSelection();
    if (item && focus) {
      framedByUser = true;
      focusOn(item.box, stage, view);
      requestFast();
      settleSharp();
    }
    renderPanels();
  };

  overlay.addEventListener("pointerdown", (event) => {
    window.clearTimeout(settle);
    dragging = true;
    moved = false;
    lastX = event.clientX;
    lastY = event.clientY;
    overlay.setPointerCapture(event.pointerId);
  });
  overlay.addEventListener("pointermove", (event) => {
    const rect = overlay.getBoundingClientRect();
    if (dragging) {
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      if (Math.hypot(dx, dy) > 3) {
        moved = true;
        framedByUser = true;
      }
      view.panX += dx;
      view.panY += dy;
      lastX = event.clientX;
      lastY = event.clientY;
      requestFast();
      return;
    }
    const world = toWorld(event.clientX - rect.left, event.clientY - rect.top, view);
    const next = locate(world.x, world.y);
    if (next !== hovered) {
      hovered = next;
      drawOverlay();
    }
    moveTooltip(event.clientX, event.clientY, next);
  });
  overlay.addEventListener("pointerup", (event) => {
    dragging = false;
    if (moved) {
      paintSharp();
      return;
    }
    const rect = overlay.getBoundingClientRect();
    const world = toWorld(event.clientX - rect.left, event.clientY - rect.top, view);
    pick(locate(world.x, world.y), false);
  });
  overlay.addEventListener("pointerleave", () => {
    hovered = null;
    required("#tooltip").hidden = true;
    drawOverlay();
  });
  overlay.addEventListener("dblclick", (event) => {
    const rect = overlay.getBoundingClientRect();
    const world = toWorld(event.clientX - rect.left, event.clientY - rect.top, view);
    const item = locate(world.x, world.y);
    if (item) pick(item, true);
  });
  const countryView = (): { scale: number; panX: number; panY: number } =>
    fitView(data.width, data.height, stage.clientWidth, stage.clientHeight, mapInset(stage));
  const applyZoom = (factor: number, cursorX: number, cursorY: number): void => {
    const fitted = countryView();
    const next = zoomAt(view.scale, view.panX, view.panY, cursorX, cursorY, factor, {
      min: fitted.scale,
      max: Math.min(8, fitted.scale * 80),
    });
    framedByUser = true;
    if (next.scale <= fitted.scale * 1.02) {
      framedByUser = false;
      Object.assign(view, fitted);
    } else Object.assign(view, next);
    requestFast();
    settleSharp();
  };

  overlay.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = overlay.getBoundingClientRect();
    applyZoom(event.deltaY < 0 ? 1.12 : 0.89, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!target) return;
    const action = target.getAttribute("data-action");
    if (action === "details") {
      const municipality = selected?.mun;
      if (!municipality) return;
      const trigger = target instanceof HTMLButtonElement ? target : null;
      if (trigger) { trigger.disabled = true; trigger.textContent = "Carregando detalhes…"; }
      const restoreTrigger = (): void => {
        if (trigger?.isConnected) { trigger.disabled = false; trigger.textContent = "Exibir detalhes da apuração"; }
      };
      const showError = (error: unknown): void => {
        const notice = document.createElement("section");
        notice.className = "details-notice";
        notice.setAttribute("role", "alertdialog");
        notice.innerHTML = `<p>${escapeHtml(error instanceof Error ? error.message : "Falha ao carregar detalhes da apuração")}</p><button type="button" data-dismiss>Fechar</button>`;
        notice.addEventListener("click", (noticeEvent) => {
          if (noticeEvent.target instanceof Element && noticeEvent.target.closest("[data-dismiss]")) notice.remove();
        });
        root.append(notice);
      };
      if (municipality.ibge === "2927408") {
        void loadSalvadorSummary().then((summary) => {
          if (selected?.mun.ibge !== municipality.ibge) { restoreTrigger(); return; }
          restoreTrigger();
          openLocais(root, summary, () => { renderPanels(); });
        }).catch((error: unknown) => { restoreTrigger(); if (selected?.mun.ibge === municipality.ibge) showError(error); });
      } else if (municipality.neighborhoodLayer && municipality.apuracaoDetalhe && data.candidatos) {
        const candidateNumbers = data.candidatos.map((candidate) => candidate.number);
        void loadNeighborhoodSummary(municipality.ibge, municipality.neighborhoodLayer, candidateNumbers)
          .then((summary) => {
            if (selected?.mun.ibge !== municipality.ibge) { restoreTrigger(); return; }
            restoreTrigger();
            openLocais(root, summary, () => { renderPanels(); }, async (place) => {
              const city = await loadMunicipalityApuracao(municipality.ibge, municipality.apuracaoDetalhe!, candidateNumbers);
              const zone = city.zones.find((item) => item.number === place.zone);
              const selectedPlace = zone?.places.find((item) => item.code === place.placeCode);
              if (!selectedPlace) throw new Error("Local não encontrado nos dados detalhados deste município.");
              return { schemaVersion: 1, place: { municipalityCode: summary.municipality.tseCode, zone: place.zone, placeCode: place.placeCode },
                sections: selectedPlace.sections.map((section) => ({ section: section.number, votesByCode: { ...section.candidateVotes, ...section.specialVotes } })) };
            });
          }).catch((error: unknown) => { restoreTrigger(); if (selected?.mun.ibge === municipality.ibge) showError(error); });
      } else if (municipality.apuracaoDetalhe && data.candidatos) {
        void loadMunicipalityApuracao(municipality.ibge, municipality.apuracaoDetalhe, data.candidatos.map((candidate) => candidate.number))
          .then((summary) => {
            if (selected?.mun.ibge !== municipality.ibge) { restoreTrigger(); return; }
            openMunicipalDetails(root, { name: municipality.nome, uf: municipality.uf }, summary, data.candidatos ?? [], () => { renderPanels(); });
          })
          .catch((error: unknown) => { restoreTrigger(); if (selected?.mun.ibge === municipality.ibge) showError(error); });
      } else {
        restoreTrigger();
        showError(new Error("Detalhes oficiais não encontrados para este município."));
      }
      return;
    }
    if (action === "vote") {
      const next = target.getAttribute("data-mode");
      if (next === "municipios" || next === "estados" || next === "vantagem") voteMode = next;
      indicator = null;
      requiredSelect("#indicator-select").value = "";
      pulseMap();
      renderPanels();
      paintSharp();
      return;
    }
    if (action === "zoom") {
      const rect = stage.getBoundingClientRect();
      applyZoom(target.getAttribute("data-factor") === "in" ? 1.25 : 0.8, rect.width / 2, rect.height / 2);
      return;
    }
    if (action === "reset") {
      framedByUser = false;
      Object.assign(view, countryView());
      requestFast();
      settleSharp();
      return;
    }
    if (action === "clear") {
      selected = null;
      syncSelection();
      renderPanels();
      return;
    }
    if (action === "pick") {
      const item = drawables.find((drawable) => drawable.mun.ibge === target.getAttribute("data-ibge")) ?? null;
      query = "";
      requiredInput("#search").value = item ? `${item.mun.nome} · ${item.mun.uf}` : "";
      pick(item, true);
      return;
    }
    renderPanels();
    paintSharp();
  });
  required("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const [first] = search(drawables, query);
    if (!first) return;
    query = "";
    requiredInput("#search").value = `${first.mun.nome} · ${first.mun.uf}`;
    pick(first, true);
  });
  requiredInput("#search").addEventListener("input", (event) => {
    query = event.target instanceof HTMLInputElement ? event.target.value : "";
    renderPanels();
  });
  requiredSelect("#indicator-select").addEventListener("change", (event) => {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : "";
    indicator = INDICATORS.find((item) => item.id === value)?.id ?? null;
    pulseMap();
    renderPanels();
    paintSharp();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (root.querySelector(".locais-dialog, .municipal-details-dialog")) return;
      selected = null;
      syncSelection();
      renderPanels();
    }
  });
  new ResizeObserver(resize).observe(stage);
  renderPanels();
  resize();
}

function paint(
  ctx: CanvasRenderingContext2D,
  drawables: readonly Drawable[],
  statePaths: readonly Path2D[],
  byUf: ReadonlyMap<string, UfAgg>,
  mode: Mode,
  width: number,
  height: number,
  dpr: number,
  view: { scale: number; panX: number; panY: number },
  countryScale: number,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.fillStyle = "#0c0e13";
  ctx.fillRect(0, 0, width * dpr, height * dpr);
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.panX, dpr * view.panY);
  const strokeMunicipal = mode === "municipios" && view.scale >= 0.2;
  const strokeWidth = (mode === "estados" ? 1.4 : 0.7) / view.scale;
  for (const item of drawables) {
    if (!intersectsView(item.box, view, width, height)) continue;
    ctx.fillStyle = item.fills[mode];
    ctx.fill(item.path, "evenodd");
    if (mode === "vantagem" || (!strokeMunicipal && mode !== "estados")) continue;
    ctx.strokeStyle = mode === "estados" ? item.fills.estados : "rgba(8, 9, 12, 0.55)";
    ctx.lineWidth = strokeWidth;
    ctx.stroke(item.path);
  }
  ctx.strokeStyle = "#000";
  ctx.lineWidth = stateOutlineWidth(view.scale, countryScale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const path of statePaths) ctx.stroke(path);
  drawStateLabels(ctx, byUf, dpr, view);
}

function mapInset(stage: HTMLElement): { top: number; right: number; bottom: number; left: number } {
  const width = stage.clientWidth;
  const topbar = stage.querySelector(".topbar");
  const dock = stage.querySelector("#dock");
  const top = Math.ceil((topbar?.getBoundingClientRect().height ?? 56) + 20);
  if (width < 900) {
    const bottom = Math.ceil((dock?.getBoundingClientRect().height ?? 240) + 12);
    return { top, right: 10, bottom, left: 10 };
  }
  return { top: 78, right: 28, bottom: 64, left: 28 };
}

function drawStateLabels(
  ctx: CanvasRenderingContext2D,
  byUf: ReadonlyMap<string, UfAgg>,
  dpr: number,
  view: { scale: number; panX: number; panY: number },
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  for (const uf of [...byUf.values()].sort((left, right) => right.vv - left.vv)) {
    const screenWidth = (uf.maxX - uf.minX) * view.scale;
    if (screenWidth < 52) continue;
    const x = view.panX + uf.x * view.scale;
    const y = view.panY + uf.y * view.scale;
    const box = { x: x - 22, y: y - 16, w: 44, h: 32 };
    if (placed.some((item) => intersects(item, box))) continue;
    placed.push(box);
    ctx.fillStyle = "#f8f5ef";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 13px sans-serif";
    ctx.fillText(uf.sigla, x, y - 7);
    ctx.font = "12px sans-serif";
    ctx.fillText(`${formatNumber(uf.winnerShare, 0)}%`, x, y + 8);
  }
}

function intersects(
  left: { x: number; y: number; w: number; h: number },
  right: { x: number; y: number; w: number; h: number },
): boolean {
  return left.x < right.x + right.w && left.x + left.w > right.x && left.y < right.y + right.h && left.y + left.h > right.y;
}

function paintHighlight(
  ctx: CanvasRenderingContext2D,
  selected: Drawable | null,
  hovered: Drawable | null,
  width: number,
  height: number,
  dpr: number,
  view: { scale: number; panX: number; panY: number },
  dim: number,
  fill: string | null,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.globalCompositeOperation = "source-over";
  if (selected && dim > 0.01 && fill) {
    ctx.fillStyle = `rgba(5, 7, 10, ${dim.toFixed(3)})`;
    ctx.fillRect(0, 0, width * dpr, height * dpr);
    ctx.globalCompositeOperation = "destination-out";
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.panX, dpr * view.panY);
    ctx.fill(selected.path, "evenodd");
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = fill;
    ctx.fill(selected.path, "evenodd");
  }
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.panX, dpr * view.panY);
  for (const item of [hovered, selected]) {
    if (!item) continue;
    ctx.strokeStyle = item === selected ? "#fffaf3" : "#f8f5ef";
    ctx.lineWidth = (item === selected ? 2.8 : 2.2) / view.scale;
    ctx.stroke(item.path);
  }
}

function assignFills(
  drawables: readonly Drawable[],
  byUf: ReadonlyMap<string, UfAgg>,
  ranges: Record<IndicatorId, [number, number]>,
): void {
  for (const item of drawables) {
    const uf = byUf.get(item.mun.uf);
    const fills: Record<string, string> = {
      municipios: candidateFlatColor(item.leader),
      vantagem: candidateAdvantageColor(item.leader, item.margem),
      estados: uf ? candidateFlatColor(uf.leader) : "#3a3f46",
    };
    for (const indicator of INDICATORS) {
      fills[indicator.id] = paintIndicator(indicatorValue(item.mun, indicator.id), ranges[indicator.id]);
    }
    item.fills = fills;
  }
}

function paintIndicator(value: number | null, range: [number, number]): string {
  if (value === null) return "#2a2e36";
  return indicatorColor(value, range[0], range[1]);
}

function countryPanel(data: MapFile, counts: Readonly<Record<string, number>>): string {
  const candidates = data.brasil.candidatos ?? [];
  const outsideVotes = Object.values(data.votosForaMunicipios ?? {}).reduce((sum, votes) => sum + votes, 0);
  const discrepancies = data.discrepanciasEA20?.length ?? 0;
  const ranked = [...candidates].sort((a, b) => b.nationalVotes - a.nationalVotes);
  const leaders = ranked.map((candidate) => `<span class="candidate-win"><i style="background:${candidateFlatColor(candidate.number)}"></i>${escapeHtml(candidate.name)} lidera em ${(counts[candidate.number] ?? 0).toLocaleString("pt-BR")} municípios</span>`).join("");
  return `
    <p class="kicker">Presidência · Brasil</p>
    <h1>Apuração por candidatura</h1>
    <p class="fine">Votos válidos · candidaturas ordenadas pela votação nacional</p>
    <div class="candidate-list">${ranked.map((candidate) => candidateRow(candidate.name, candidate.party, candidate.nationalVotes, candidate.nationalPercent, candidate.number)).join("")}</div>
    <p class="fine">O total nacional do TSE inclui ${outsideVotes.toLocaleString("pt-BR")} votos válidos sem município brasileiro (inclui exterior); esses votos não são atribuídos ao mapa.</p>
    ${discrepancies ? `<p class="data-warning fine">Há divergências entre o agregado municipal EA20 e o CSV de votação por seção em ${discrepancies} municípios; o mapa e os detalhes usam a soma por seção. Ao selecionar um deles, a diferença é informada.</p>` : ""}
    <div class="candidate-wins">${leaders}</div>
    <p class="fine">Abstenção ${formatNumber(data.brasil.ab, 1)}%${data.brasil.brancos === undefined ? "" : ` · brancos ${formatNumber(data.brasil.brancos, 1)}% · nulos ${formatNumber(data.brasil.nulos ?? 0, 1)}%`}. Arraste o mapa, use a roda para aproximar e selecione um município.</p>`;
}

function placePanel(mun: Mun, data: MapFile): string {
  const candidates = [...(mun.candidatos ?? [])].sort((a, b) => b.votes - a.votes);
  const total = candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
  const first = candidates[0];
  const second = candidates[1];
  const winner = first && second && first.votes === second.votes ? "empate" : first?.number ?? "empate";
  const margin = total && first && second ? 100 * (first.votes - second.votes) / total : 0;
  const uf = data.ufIndicadores[mun.uf];
  const detailHint = mun.ibge === "2927408" ? "Bairros, zonas eleitorais, locais e seções." : "Zonas eleitorais, locais de votação e seções.";
  return `
    <p class="kicker">${escapeHtml(mun.uf)} · ${escapeHtml(REGIAO[mun.uf] ?? "")}</p>
    <div class="section-head"><h1>${escapeHtml(mun.nome)}</h1><button class="text-button" type="button" data-action="clear">fechar</button></div>
    <button class="details-action" type="button" data-action="details" aria-describedby="details-availability">Exibir detalhes da apuração</button>
    <p class="details-availability fine" id="details-availability">${detailHint}</p>
    <p class="fine">${escapeHtml(candidateName(winner, data.candidatos ?? []))} ${winner === "empate" ? "empatam" : "lidera"} com ${formatNumber(first ? 100 * first.votes / Math.max(1, total) : 0, 1)}%${second ? ` · margem de ${formatNumber(margin, 1)} p.p.` : ""}.</p>
    <div class="candidate-list">${candidates.map((candidate) => candidateRow(candidate.name, candidate.party, candidate.votes, total ? 100 * candidate.votes / total : 0, candidate.number)).join("")}</div>
    <p class="fine">${mun.populacao ? `${Math.round(mun.populacao).toLocaleString("pt-BR")} habitantes · ` : ""}${total.toLocaleString("pt-BR")} votos válidos · ${formatNumber(mun.ap, 0)}% das seções.</p>
    ${mun.votosValidosEA20 === undefined ? "" : `<p class="data-warning fine">Os arquivos oficiais divergem: EA20 registra ${mun.votosValidosEA20.toLocaleString("pt-BR")} votos válidos; a soma do CSV por seção é ${total.toLocaleString("pt-BR")} (${(total - mun.votosValidosEA20) > 0 ? "+" : ""}${(total - mun.votosValidosEA20).toLocaleString("pt-BR")}). Mapa e detalhes usam a votação por seção.</p>`}
    ${typeof mun.lula22 === "number" ? `<p class="fine">Em 2022, Lula teve ${formatNumber(mun.lula22, 1)}% e Bolsonaro ${formatNumber(mun.pl22 ?? 0, 1)}% dos votos válidos.</p>` : ""}
    <div class="bars">
      ${INDICATORS.map((indicator) => indicatorRow(indicator, indicatorValue(mun, indicator.id), uf?.[indicator.id])).join("")}
    </div>
    <p class="fine">A barra compara o município com o valor da UF, quando ele existe na mesma fonte.</p>`;
}

function candidateRow(name: string, party: string, votes: number, share: number, number: string): string {
  return `<article class="candidate-row"><div class="candidate-row-head"><span><i style="background:${candidateFlatColor(number)}"></i><b>${escapeHtml(name)}</b><small>${escapeHtml(party)}</small></span><strong>${votes.toLocaleString("pt-BR")} <small>${formatNumber(share, 1)}%</small></strong></div><div class="candidate-track"><i style="width:${Math.min(100, Math.max(0, share))}%;background:${candidateFlatColor(number)}"></i></div></article>`;
}

function correlationPanel(data: MapFile, drawables: readonly Drawable[], mode: Mode, selected: Drawable | null): string {
  const meta = INDICATORS.find((item) => item.id === mode);
  const id = meta?.id ?? "analfabetismo";
  const rows = drawables.filter((item) => indicatorValue(item.mun, id) !== null);
  const line = pearson(rows.map((item) => indicatorValue(item.mun, id) as number), rows.map((item) => item.margem));
  const here = selected ? indicatorValue(selected.mun, id) : null;
  return `
    <p class="kicker">${escapeHtml(meta?.nome ?? "")} · ${escapeHtml(meta?.ano ?? "")}</p>
    <h2>r ${formatNumber(line.r, 2)}</h2>
    <p class="fine">${escapeHtml(correlationSentence(meta?.nome.toLowerCase() ?? "indicador", line, "municípios"))} Cada município pesa igual, não cada eleitor.</p>
    <p class="fine">${here === null || here === undefined ? "Clique um município para ver o valor local." : `${selected?.mun.nome}: ${formatIndicator(id, here)}.`} ${rows.length.toLocaleString("pt-BR")} municípios com dado.</p>
    <p class="fine">Votos do TSE e malha do IBGE. Correlação territorial não explica o voto individual.</p>`;
}

function regionPanel(byUf: ReadonlyMap<string, UfAgg>, candidates: readonly Candidate[]): string {
  const grouped = new Map<string, { votes: number; candidateVotes: Map<string, number> }>();
  for (const uf of byUf.values()) {
    const region = REGIAO[uf.sigla] ?? "Outras";
    const current = grouped.get(region) ?? { votes: 0, candidateVotes: new Map<string, number>() };
    current.votes += uf.vv;
    for (const [number, votes] of uf.candidateVotes.entries()) current.candidateVotes.set(number, (current.candidateVotes.get(number) ?? 0) + votes);
    grouped.set(region, current);
  }
  const order = ["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"];
  return `
    <p class="kicker">Por região</p>
    <h2>Vencedor e votação de cada candidatura</h2>
    <div class="region-list">
      ${order.map((region) => {
        const item = grouped.get(region);
        if (!item) return "";
        const ranked = [...item.candidateVotes].sort((a, b) => b[1] - a[1]);
        const tied = ranked[0]?.[1] === ranked[1]?.[1];
        const winner = tied ? null : ranked[0];
        const share = item.votes ? 100 * (winner?.[1] ?? 0) / item.votes : 0;
        const name = candidates.find((candidate) => candidate.number === winner?.[0])?.name ?? "Empate";
        return `<details><summary><span>${region}</span><b><i style="background:${candidateFlatColor(winner?.[0] ?? "empate")}"></i>${escapeHtml(name)} ${formatNumber(share, 1)}%</b></summary><div class="candidate-list">${candidates.map((candidate) => candidateRow(candidate.name, candidate.party, item.candidateVotes.get(candidate.number) ?? 0, item.votes ? 100 * (item.candidateVotes.get(candidate.number) ?? 0) / item.votes : 0, candidate.number)).join("")}</div></details>`;
      }).join("")}
    </div>
    <p class="fine">Soma das votações nos municípios brasileiros. Votos do exterior estão no total nacional, não na comparação regional.</p>`;
}

function legend(mode: Mode, counts: Readonly<Record<string, number>>, ranges: Record<IndicatorId, [number, number]>, candidates: readonly Candidate[]): string {
  if (isIndicator(mode)) {
    const [min, max] = ranges[mode];
    return `<span>${formatIndicator(mode, min)}</span><i class="swatch" style="background:linear-gradient(90deg,#4e8ea8,#e07a46)"></i><span>${formatIndicator(mode, max)}</span>`;
  }
  if (mode === "vantagem") {
    return `<span>margem estreita</span><i class="swatch" style="background:linear-gradient(90deg,#e8e2d8,#8b8178)"></i><span>margem ampla · cor do vencedor</span>`;
  }
  return `<span>${mode === "estados" ? "Vencedor em cada UF:" : "Vencedor em cada município:"}</span>${candidates.map((candidate) => `<span class="legend-candidate"><i style="background:${candidateFlatColor(candidate.number)}"></i>${escapeHtml(candidate.name)}${mode === "municipios" ? ` · ${counts[candidate.number] ?? 0}` : ""}</span>`).join("")}`;
}

function shell(): string {
  return `
    <main class="stage" id="stage">
      <canvas id="base"></canvas>
      <canvas id="overlay"></canvas>
      <header class="topbar">
        <strong class="brand">Chão e urna <span>mapa 2026</span></strong>
        <form class="search" id="search-form" role="search">
          <input id="search" type="search" placeholder="Buscar município ou UF" autocomplete="off" />
          <div id="search-results" class="search-results" hidden></div>
        </form>
        <p class="status" id="status"></p>
      </header>
      <div class="dock" id="dock">
      <section class="panel left" id="left-card">
        <div class="map-controls">
          <div class="segment" role="group" aria-label="Como ver o voto">
            <button type="button" data-action="vote" data-mode="municipios" aria-pressed="true">Municípios</button>
            <button type="button" data-action="vote" data-mode="vantagem">Vantagem</button>
            <button type="button" data-action="vote" data-mode="estados">Estados</button>
          </div>
          <label class="cross">Cruzar com
            <select id="indicator-select">
              <option value="">Só o voto</option>
              ${INDICATORS.map((item) => `<option value="${item.id}">${item.nome}</option>`).join("")}
            </select>
          </label>
        </div>
        <div id="left-panel"></div>
      </section>
      <aside class="panel right" id="right-panel"></aside>
      <div class="legend" id="legend"></div>
      </div>
      <div class="zoom">
        <button type="button" data-action="zoom" data-factor="in" aria-label="Aproximar">+</button>
        <button type="button" data-action="zoom" data-factor="out" aria-label="Afastar">−</button>
        <button type="button" data-action="reset" aria-label="Ver o Brasil">⌂</button>
      </div>
      <div class="tooltip" id="tooltip" hidden></div>
    </main>`;
}

function toPath(polygons: Mun["g"]): Path2D {
  const path = new Path2D();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ring.length < 6) continue;
      path.moveTo(ring[0], ring[1]);
      for (let index = 2; index < ring.length; index += 2) path.lineTo(ring[index], ring[index + 1]);
      path.closePath();
    }
  }
  return path;
}

function toDrawable(mun: Mun): Drawable {
  const path = toPath(mun.g);
  let box: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const polygon of mun.g) {
    for (const ring of polygon) {
      if (ring.length < 6) continue;
      const next = ringBBox(ring);
      box = {
        minX: Math.min(box.minX, next.minX),
        minY: Math.min(box.minY, next.minY),
        maxX: Math.max(box.maxX, next.maxX),
        maxY: Math.max(box.maxY, next.maxY),
      };
    }
  }
  const result = resultForMunicipality(mun);
  return {
    mun,
    path,
    box,
    leader: result.winner,
    margem: result.margin,
    winnerShare: result.share,
    fills: {
      municipios: "#2a2e36",
      vantagem: "#2a2e36",
      estados: "#2a2e36",
    },
  };
}

function hit(grid: SpatialGrid<Drawable>, x: number, y: number): Drawable | null {
  let found: Drawable | null = null;
  let area = Infinity;
  for (const item of querySpatialGrid(grid, x, y)) {
    if (!contains(item.box, x, y)) continue;
    const boxArea = (item.box.maxX - item.box.minX) * (item.box.maxY - item.box.minY);
    if (boxArea >= area) continue;
    if (!inside(item.mun, x, y)) continue;
    found = item;
    area = boxArea;
  }
  return found;
}

function inside(mun: Mun, x: number, y: number): boolean {
  return mun.g.some((polygon) => polygon[0] && pointInRing(x, y, polygon[0]) && !polygon.slice(1).some((ring) => pointInRing(x, y, ring)));
}

interface UfAgg {
  readonly sigla: string;
  fv: number;
  lv: number;
  vv: number;
  fp: number;
  lp: number;
  margem: number;
  leader: Leader;
  winnerShare: number;
  candidateVotes: Map<string, number>;
  x: number;
  y: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function aggregate(drawables: readonly Drawable[]): Map<string, UfAgg> {
  const grouped = new Map<string, UfAgg>();
  for (const item of drawables) {
    const current = grouped.get(item.mun.uf) ?? {
      sigla: item.mun.uf, fv: 0, lv: 0, vv: 0, fp: 0, lp: 0, margem: 0, leader: "empate" as Leader, winnerShare: 0, candidateVotes: new Map<string, number>(),
      x: 0, y: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    };
    current.minX = Math.min(current.minX, item.box.minX);
    current.minY = Math.min(current.minY, item.box.minY);
    current.maxX = Math.max(current.maxX, item.box.maxX);
    current.maxY = Math.max(current.maxY, item.box.maxY);
    current.fv += item.mun.fv;
    current.lv += item.mun.lv;
    current.vv += item.mun.vv;
    for (const candidate of item.mun.candidatos ?? []) current.candidateVotes.set(candidate.number, (current.candidateVotes.get(candidate.number) ?? 0) + candidate.votes);
    current.x += ((item.box.minX + item.box.maxX) / 2) * item.mun.vv;
    current.y += ((item.box.minY + item.box.maxY) / 2) * item.mun.vv;
    grouped.set(item.mun.uf, current);
  }
  for (const uf of grouped.values()) {
    uf.fp = uf.vv ? (100 * uf.fv) / uf.vv : 0;
    uf.lp = uf.vv ? (100 * uf.lv) / uf.vv : 0;
    const ranked = [...uf.candidateVotes].sort((a, b) => b[1] - a[1]);
    const totalVotes = ranked.reduce((sum, [, votes]) => sum + votes, 0);
    uf.leader = ranked[0] && ranked[0][1] !== ranked[1]?.[1] ? ranked[0][0] : "empate";
    uf.margem = totalVotes && ranked[0] && ranked[1] ? 100 * (ranked[0][1] - ranked[1][1]) / totalVotes : 0;
    uf.winnerShare = totalVotes ? 100 * (ranked[0]?.[1] ?? 0) / totalVotes : 0;
    uf.x = uf.vv ? uf.x / uf.vv : uf.x;
    uf.y = uf.vv ? uf.y / uf.vv : uf.y;
  }
  return grouped;
}

function search(drawables: readonly Drawable[], query: string): Drawable[] {
  const needle = normalize(query);
  if (needle.length < 2) return [];
  return drawables.filter((item) => normalize(`${item.mun.nome} ${item.mun.uf}`).includes(needle)).slice(0, 8);
}

function focusOn(box: BBox, stage: HTMLElement, view: { scale: number; panX: number; panY: number }): void {
  const width = Math.max(1, box.maxX - box.minX);
  const height = Math.max(1, box.maxY - box.minY);
  const scale = Math.min(8, Math.min((stage.clientWidth * 0.45) / width, (stage.clientHeight * 0.45) / height));
  view.scale = scale;
  view.panX = stage.clientWidth / 2 - ((box.minX + box.maxX) / 2) * scale;
  view.panY = stage.clientHeight / 2 - ((box.minY + box.maxY) / 2) * scale;
}

function moveTooltip(x: number, y: number, item: Drawable | null): void {
  const tooltip = required("#tooltip");
  if (!item) {
    tooltip.hidden = true;
    return;
  }
  tooltip.hidden = false;
  tooltip.innerHTML = `<b>${escapeHtml(item.mun.nome)}</b>${item.mun.uf} · ${escapeHtml(candidateName(item.leader, item.mun.candidatos ?? []))} ${formatNumber(item.winnerShare, 1)}%`;
  const pad = 8;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(pad, Math.min(x + 14, window.innerWidth - width - pad))}px`;
  tooltip.style.top = `${Math.max(pad, Math.min(y + 14, window.innerHeight - height - pad))}px`;
}

function toWorld(x: number, y: number, view: { scale: number; panX: number; panY: number }): { x: number; y: number } {
  return { x: (x - view.panX) / view.scale, y: (y - view.panY) / view.scale };
}

function indicatorValue(mun: Mun, id: IndicatorId): number | null {
  if (id === "abstencao") return mun.ab;
  const value = mun[id];
  return typeof value === "number" ? value : null;
}

function isIndicator(mode: Mode): mode is IndicatorId {
  return INDICATORS.some((item) => item.id === mode);
}

function extent(drawables: readonly Drawable[], id: IndicatorId): [number, number] {
  const values = drawables.map((item) => indicatorValue(item.mun, id)).filter((value): value is number => value !== null);
  if (values.length === 0) return [0, 1];
  return [Math.min(...values), Math.max(...values)];
}

function indicatorMode(mode: Mode): boolean {
  return isIndicator(mode);
}

function indicatorRow(indicator: (typeof INDICATORS)[number], value: number | null, uf: number | undefined): string {
  if (value === null) return "";
  const magnitude = Math.max(Math.abs(value), Math.abs(uf ?? value), 1);
  const comparison = uf === undefined ? "" : ` · UF ${formatIndicator(indicator.id, uf)}`;
  return `<div><span>${indicator.nome}</span><span class="track"><i style="width:${(Math.abs(value) / magnitude) * 100}%"></i></span><span>${formatIndicator(indicator.id, value)}${comparison}</span></div>`;
}

function formatIndicator(id: string, value: number): string {
  const unit = INDICATORS.find((item) => item.id === id)?.unidade;
  if (unit === "R$") return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  if (unit === "hab/km²") return `${formatNumber(value, value >= 100 ? 0 : 1)} hab/km²`;
  if (unit === "p.p.") return `${value > 0 ? "+" : ""}${formatNumber(value, 1)} p.p.`;
  return `${formatNumber(value, 1)}%`;
}

function candidateName(number: string, candidates: readonly { readonly number: string; readonly name: string }[]): string {
  return number === "empate" ? "Empate" : candidates.find((candidate) => candidate.number === number)?.name ?? `Candidatura ${number}`;
}

function resultForMunicipality(mun: Mun): { winner: string; margin: number; share: number } {
  const votes = mun.candidatos?.length ? mun.candidatos : [
    { number: "22", name: "Flávio", party: "PL", votes: mun.fv },
    { number: "13", name: "Lula", party: "PT", votes: mun.lv },
  ];
  const ranked = [...votes].sort((a, b) => b.votes - a.votes);
  const total = ranked.reduce((sum, candidate) => sum + candidate.votes, 0);
  const winner = ranked[0] && ranked[0].votes !== ranked[1]?.votes ? ranked[0].number : "empate";
  return {
    winner,
    margin: total && ranked[0] && ranked[1] ? 100 * (ranked[0].votes - ranked[1].votes) / total : 0,
    share: total ? 100 * (ranked[0]?.votes ?? 0) / total : 0,
  };
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}

function required(selector: string): HTMLElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${selector}`);
  return node;
}

function requiredCanvas(selector: string): HTMLCanvasElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLCanvasElement)) throw new Error(`missing ${selector}`);
  return node;
}

function requiredInput(selector: string): HTMLInputElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLInputElement)) throw new Error(`missing ${selector}`);
  return node;
}

function requiredSelect(selector: string): HTMLSelectElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLSelectElement)) throw new Error(`missing ${selector}`);
  return node;
}
