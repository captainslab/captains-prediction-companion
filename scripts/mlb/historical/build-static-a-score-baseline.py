#!/usr/bin/env python3
"""Static-A, market-free MLB score baseline for the CPC B/C benchmark.

This is a baseline comparator, not production-model reproduction. It reads only
Retrosheet team scoring rows through 2024, fits on A (<= 2023-12-31), freezes,
and emits B/C predictions keyed to the CPC identity ledger. D/future Retrosheet
rows are rejected before their outcomes are read.
"""
from __future__ import annotations
import argparse, csv, hashlib, io, json, math, statistics, sys, zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA="cpc_mlb_historical_prediction_v1"; MODEL_ID="retrosheet-static-a-team-form-ridge"; VERSION="1.0.0"
TRAIN_END="2023-12-31"; RIDGE=100.0; OUT="artifacts/mlb-historical-predictions.jsonl"; CFG="artifacts/mlb-static-a-score-baseline-config.json"; LEDGER="artifacts/mlb-historical-market-ledger.json"
FEATURES=("is_home","league_prior","off5","off15","off30","opp5","opp15","opp30")
TEAM={"ANA":"Los Angeles Angels","ARI":"Arizona Diamondbacks","ATL":"Atlanta Braves","BAL":"Baltimore Orioles","BOS":"Boston Red Sox","CHA":"Chicago White Sox","CHN":"Chicago Cubs","CIN":"Cincinnati Reds","CLE":"Cleveland Guardians","COL":"Colorado Rockies","DET":"Detroit Tigers","HOU":"Houston Astros","KCA":"Kansas City Royals","LAN":"Los Angeles Dodgers","MIA":"Miami Marlins","MIL":"Milwaukee Brewers","MIN":"Minnesota Twins","NYA":"New York Yankees","NYN":"New York Mets","OAK":"Oakland Athletics","PHI":"Philadelphia Phillies","PIT":"Pittsburgh Pirates","SDN":"San Diego Padres","SEA":"Seattle Mariners","SFN":"San Francisco Giants","SLN":"St. Louis Cardinals","TBA":"Tampa Bay Rays","TEX":"Texas Rangers","TOR":"Toronto Blue Jays","WAS":"Washington Nationals"}

def num(x):
    try:
        v=float(x); return v if math.isfinite(v) else None
    except (TypeError,ValueError): return None

def avg(xs):
    v=[float(x) for x in xs if x is not None and math.isfinite(float(x))]; return sum(v)/len(v) if v else None

def norm(s): return " ".join("".join(c.lower() if c.isalnum() else " " for c in str(s or "")).split())
def part(d): return "B" if "2024-03-20"<=d<="2024-06-30" else "C" if "2024-07-01"<=d<="2024-09-29" else "D" if "2025-03-18"<=d<="2025-09-28" else "OUTSIDE"
def ymd(x):
    s=str(x or "").strip().replace(".0","")
    if len(s)==8 and s.isdigit(): return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    if len(s)>=10 and s[4]=="-" and s[7]=="-": return s[:10]
    raise ValueError(f"bad date {x}")

def members(path):
    def walk(z):
        for i in z.infolist():
            if i.is_dir(): continue
            b=z.read(i)
            if i.filename.lower().endswith(".zip"):
                with zipfile.ZipFile(io.BytesIO(b)) as n: yield from walk(n)
            else: yield i.filename,b
    with zipfile.ZipFile(path) as z: yield from walk(z)

def load_games(archives):
    rows={}; parts=0
    for a in archives:
        for name,data in members(Path(a)):
            if not Path(name).name.lower().endswith("teamstats.csv"): continue
            parts+=1
            for r in csv.DictReader(io.StringIO(data.decode("utf-8-sig",errors="replace"))):
                if str(r.get("stattype","value")).lower()!="value" or str(r.get("gametype","regular")).lower() not in {"regular","r",""}: continue
                d=ymd(r.get("date"))
                if d>="2025-01-01": raise RuntimeError(f"D_OR_FUTURE_RETROSHEET_FORBIDDEN:{d}")
                gid=str(r.get("gid") or "").strip(); team=str(r.get("team") or "").strip().upper(); opp=str(r.get("opp") or "").strip().upper(); ha=str(r.get("vishome") or "").strip().lower(); runs=num(r.get("b_r"))
                if not gid or not team or not opp or ha not in {"h","v"} or runs is None: continue
                rows[(gid,team)]={"gid":gid,"date":d,"season":int(d[:4]),"number":int(num(r.get("number")) or 0),"team":team,"opp":opp,"is_home":1 if ha=="h" else 0,"runs":runs}
    if not parts: raise RuntimeError("No teamstats.csv found")
    by=defaultdict(list)
    for r in rows.values(): by[r["gid"]].append(r)
    raw=[]
    for gid,rs in by.items():
        h=[r for r in rs if r["is_home"]]; a=[r for r in rs if not r["is_home"]]
        if len(h)==len(a)==1 and h[0]["date"]==a[0]["date"]: raw.append({"gid":gid,"date":h[0]["date"],"season":h[0]["season"],"number":max(h[0]["number"],a[0]["number"]),"home":h[0],"away":a[0]})
    raw.sort(key=lambda g:(g["date"],g["number"],g["gid"]))
    off=defaultdict(list); allow=defaultdict(list); league=[]; out=[]; days=defaultdict(list)
    for g in raw: days[g["date"]].append(g)
    for d in sorted(days):
        lp=avg(league)
        for g in days[d]:
            f={}
            for side in ("away","home"):
                r=g[side]; oh=off[r["team"]]; ah=allow[r["opp"]]
                f[side]={"is_home":float(r["is_home"]),"league_prior":lp,"off5":avg(oh[-5:]),"off15":avg(oh[-15:]),"off30":avg(oh[-30:]),"opp5":avg(ah[-5:]),"opp15":avg(ah[-15:]),"opp30":avg(ah[-30:])}
            out.append({**g,"features":f})
        for g in days[d]:
            a,h=g["away"],g["home"]; off[a["team"]].append(a["runs"]); off[h["team"]].append(h["runs"]); allow[a["team"]].append(h["runs"]); allow[h["team"]].append(a["runs"]); league += [a["runs"],h["runs"]]
    return out,parts

def solve(A,b):
    n=len(b); m=[list(map(float,A[i]))+[float(b[i])] for i in range(n)]
    for c in range(n):
        p=max(range(c,n),key=lambda r:abs(m[r][c])); m[c],m[p]=m[p],m[c]
        if abs(m[c][c])<1e-12: raise RuntimeError("singular ridge system")
        q=m[c][c]; m[c]=[x/q for x in m[c]]
        for r in range(n):
            if r==c: continue
            q=m[r][c]
            if q: m[r]=[m[r][j]-q*m[c][j] for j in range(n+1)]
    return [m[i][n] for i in range(n)]

def fit(games):
    rows=[]
    for g in games:
        if g["date"]>TRAIN_END: continue
        for s in ("away","home"): rows.append((g["features"][s],g[s]["runs"]))
    means=[]; std=[]
    for k in FEATURES:
        v=[num(f.get(k)) for f,_ in rows]; v=[x for x in v if x is not None]; mu=avg(v) or 0.; means.append(mu); sd=statistics.pstdev(v) if len(v)>1 else 1.; std.append(sd if sd>1e-9 else 1.)
    p=len(FEATURES)+1; A=[[0.]*p for _ in range(p)]; b=[0.]*p
    for f,y in rows:
        x=[1.]+[((num(f.get(k)) if num(f.get(k)) is not None else means[i])-means[i])/std[i] for i,k in enumerate(FEATURES)]
        for i in range(p):
            b[i]+=x[i]*y
            for j in range(i,p): A[i][j]+=x[i]*x[j]
    for i in range(p):
        for j in range(i): A[i][j]=A[j][i]
    for i in range(1,p): A[i][i]+=RIDGE
    return {"beta":solve(A,b),"means":means,"std":std,"rows":len(rows)}

def predict(model,f):
    x=[1.]+[((num(f.get(k)) if num(f.get(k)) is not None else model["means"][i])-model["means"][i])/model["std"][i] for i,k in enumerate(FEATURES)]
    return max(1.,min(9.,sum(a*b for a,b in zip(model["beta"],x))))

def pois(lam,n=20):
    p=math.exp(-lam); vals=[p]
    for k in range(1,n+1): p*=lam/k; vals.append(p)
    out={str(i):vals[i] for i in range(n+1)}; out[f"{n+1}_plus"]=max(0.,1.-sum(vals)); z=sum(out.values()); return {k:v/z for k,v in out.items()}
def p_home(h,a):
    def pmf(l):
        p=math.exp(-l); v=[p]
        for k in range(1,41): p*=l/k; v.append(p)
        z=sum(v); return [x/z for x in v]
    H,A=pmf(h),pmf(a); win=tie=cdf=0.
    for i,ph in enumerate(H):
        if i: cdf+=A[i-1]
        win+=ph*cdf; tie+=ph*A[i]
    return max(0.,min(1.,win+.5*tie))

def identities(path):
    p=json.loads(Path(path).read_text()); out={}
    for r in p.get("rows",[]):
        d=str(r.get("game_date") or ""); pt=str(r.get("partition") or part(d)).upper()
        if pt=="D" or part(d)=="D": raise RuntimeError("D_PARTITION_FORBIDDEN")
        if pt not in {"B","C"}: continue
        pk=int(r["game_pk"]); x={k:r.get(k) for k in ("game_pk","game_date","start_time_utc","away_team","home_team","distribution_id")}; x["partition"]=pt
        if pk in out and out[pk]!=x: raise RuntimeError(f"inconsistent identity {pk}")
        out[pk]=x
    return list(out.values())

def match(games,ids):
    G=defaultdict(list); I=defaultdict(list)
    for g in games:
        if part(g["date"]) not in {"B","C"}: continue
        an,hn=TEAM.get(g["away"]["team"]),TEAM.get(g["home"]["team"])
        if an and hn: G[(g["date"],norm(an),norm(hn))].append(g)
    for i in ids: I[(i["game_date"],norm(i["away_team"]),norm(i["home_team"]))].append(i)
    pairs=[]; bad=[]
    for k,gs in G.items():
        ii=sorted(I.get(k,[]),key=lambda x:str(x.get("start_time_utc") or "")); gs=sorted(gs,key=lambda x:(x["number"],x["gid"]))
        if len(ii)==len(gs) and gs: pairs += list(zip(gs,ii))
        else: bad += [{"gid":g["gid"],"reason":"IDENTITY_MATCH_COUNT_MISMATCH","feature_count":len(gs),"identity_count":len(ii)} for g in gs]
    return pairs,bad

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--archive",action="append",required=False); ap.add_argument("--market-ledger",default=LEDGER); ap.add_argument("--output",default=OUT); ap.add_argument("--config-out",default=CFG); ap.add_argument("--self-test",action="store_true"); a=ap.parse_args()
    if a.self_test:
        d=pois(8.5); assert abs(sum(d.values())-1)<1e-9 and 0<p_home(4.8,4.1)<1 and part("2024-04-01")=="B" and part("2025-04-01")=="D"; print('{"status":"PASS"}'); return
    if not a.archive: raise RuntimeError("At least one --archive is required")
    games,parts=load_games(a.archive); model=fit(games)
    cfg={"schema_version":1,"model_id":MODEL_ID,"model_version":VERSION,"role":"STATIC_A_BASELINE_COMPARATOR_NOT_PRODUCTION_REPRODUCTION","source":"Retrosheet teamstats.csv","source_parts":parts,"feature_policy":"PRIOR_CALENDAR_DATE_ONLY","features":FEATURES,"trained_through":TRAIN_END,"ridge_lambda":RIDGE,"ridge_selection":"A_ONLY_DEVELOPMENT_FIXED_BEFORE_BC_BENCHMARK","run_mean_clamp":[1.,9.],"probability_model":"INDEPENDENT_POISSON","a_training_rows":model["rows"],"coefficients_standardized":model["beta"],"feature_means":model["means"],"feature_stds":model["std"],"d_partition_touched":False}
    h=hashlib.sha256(json.dumps(cfg,sort_keys=True,separators=(",",":")).encode()).hexdigest(); cfg["model_config_sha256"]=h
    pairs,bad=match(games,identities(a.market_ledger)); rows=[]
    for g,i in pairs:
        cutoff=(datetime.strptime(i["game_date"],"%Y-%m-%d").replace(tzinfo=timezone.utc)-timedelta(seconds=1)).isoformat().replace("+00:00","Z")
        start=datetime.fromisoformat(str(i["start_time_utc"]).replace("Z","+00:00")); co=datetime.fromisoformat(cutoff.replace("Z","+00:00"))
        if not co<start: bad.append({"game_pk":i["game_pk"],"reason":"FEATURE_CUTOFF_NOT_PREGAME"}); continue
        ar,hr=predict(model,g["features"]["away"]),predict(model,g["features"]["home"])
        rows.append({"schema_version":SCHEMA,"game_pk":i["game_pk"],"game_date":i["game_date"],"partition":i["partition"],"start_time_utc":i["start_time_utc"],"prediction_as_of_utc":cutoff,"trained_through":TRAIN_END,"distribution_id":i["distribution_id"],"model_id":MODEL_ID,"model_version":VERSION,"model_config_sha256":h,"outputs":{"moneyline_home":round(p_home(hr,ar),8),"total_runs_distribution":{k:round(v,10) for k,v in pois(hr+ar).items()}}})
    rows.sort(key=lambda r:(r["game_date"],r["start_time_utc"],r["game_pk"])); Path(a.output).parent.mkdir(parents=True,exist_ok=True); Path(a.output).write_text("".join(json.dumps(r,sort_keys=True)+"\n" for r in rows)); Path(a.config_out).write_text(json.dumps({**cfg,"prediction_rows":len(rows),"identity_exclusions":bad},indent=2,sort_keys=True)+"\n")
    by=defaultdict(int)
    for r in rows: by[r["partition"]]+=1
    print(json.dumps({"status":"OK" if rows else "BLOCKED","output":str(Path(a.output).resolve()),"config_output":str(Path(a.config_out).resolve()),"prediction_rows":len(rows),"partition_rows":dict(by),"identity_exclusions":len(bad),"a_training_rows":model["rows"],"model_config_sha256":h,"d_partition_touched":False},indent=2,sort_keys=True))
if __name__=="__main__":
    try: main()
    except Exception as e: print(f"ERROR: {e}",file=sys.stderr); raise
