"""Print a compact check of the local snapshot."""

from __future__ import annotations

import json
from pathlib import Path

snapshot = json.loads(Path("public/data/snapshot.json").read_text())
brasil = snapshot["brasil"]
print("atualizado", brasil["atualizadoEm"], "secoes", brasil["secoesTotalizadas"])
print("brasil indicadores", brasil["indicadores"])
print("candidatos", [(c["nomeUrna"], c["partido"], c["percentual"]) for c in brasil["candidatos"][:5]])
print("mapa", len(snapshot["mapa"]), "path0", len(snapshot["mapa"][0]["d"]))
print("indicadores meta", [(item["id"], item["ano"]) for item in snapshot["indicadores"]])
print("---")
for state in sorted(snapshot["ufs"], key=lambda item: item["margem"]):
    ind = state["indicadores"]
    print(
        f"{state['sigla']:2} {state['lider']:6} margem={state['margem']:7.2f} "
        f"flavio={state['flavio']['percentual']:6.2f} lula={state['lula']['percentual']:6.2f} "
        f"analf={ind['analfabetismo']:5.2f} esgoto={ind['esgoto']:6.2f} "
        f"agua={ind['agua']:6.2f} renda={ind['renda']:8.1f} gini={ind['gini']:.3f} "
        f"desoc={ind['desocupacao']:5.2f} abs={state['abstencao']:5.2f}"
    )
