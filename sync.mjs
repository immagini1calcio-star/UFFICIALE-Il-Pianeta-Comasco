// Il Pianeta Comasco - raccolta dati SofaScore -> Google Sheets (via Apps Script)
// Node 20+, nessuna dipendenza. Variabili: APPS_SCRIPT_URL, APPS_SCRIPT_TOKEN, (opz.) MAX_EVENTS
// Nessun dato inventato: se SofaScore non risponde, la cella resta vuota e l'errore finisce nel foglio "Log".

const BASE = 'https://www.sofascore.com/api/v1';
const GAS_URL = process.env.APPS_SCRIPT_URL;
const TOKEN = process.env.APPS_SCRIPT_TOKEN;
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 120); // partite con dettagli per esecuzione; l'archivio si completa a ondate
const TEAMS = [
  { id: 2704, label: 'Como maschile' },
  { id: 206254, label: 'Como Primavera' },
  { id: 1114927, label: 'Como Women' },
];
if (!GAS_URL || !TOKEN) { console.error('Mancano APPS_SCRIPT_URL / APPS_SCRIPT_TOKEN'); process.exit(1); }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://www.sofascore.com/',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();
const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
const local = (t) => (t ? new Date(t * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }) : null);
const errors = [];
let blocked = 0;

async function sofa(path) {
  await sleep(400);
  try {
    const r = await fetch(BASE + path, { headers: HEADERS });
    if (r.status === 404) return null; // dato non disponibile, non è un errore
    if (!r.ok) {
      errors.push({ path, status: r.status });
      if (r.status === 403 || r.status === 429) blocked++;
      if (blocked >= 6) throw new Error('STOP: SofaScore blocca le richieste (403/429 ripetuti)');
      return null;
    }
    return await r.json();
  } catch (e) {
    if (String(e.message).startsWith('STOP')) throw e;
    errors.push({ path, status: 'ERR ' + e.message });
    return null;
  }
}

async function gas(body) {
  const r = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: TOKEN, ...body }), redirect: 'follow' });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { throw new Error('Apps Script risposta non valida: ' + t.slice(0, 200)); }
  if (!j.ok) throw new Error('Apps Script: ' + j.error);
  return j;
}

async function push(sheet, rows) {
  if (!rows.length) return;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  for (let i = 0; i < rows.length; i += 400) {
    await gas({ sheet, key: 'chiave', columns, rows: rows.slice(i, i + 400) });
  }
  console.log(`  ${sheet}: ${rows.length} righe`);
}

function eventRow(e, label, extra = {}) {
  const t = e.tournament || {}, ut = t.uniqueTournament || {};
  return {
    chiave: String(e.id), eventId: e.id, squadra_como: label,
    competizione_id: ut.id, torneo_id: t.id, competizione: ut.name || t.name, categoria: ut.category?.name,
    stagione_id: e.season?.id, stagione: e.season?.name, turno: e.roundInfo?.name || e.roundInfo?.round,
    data_utc: iso(e.startTimestamp), data_locale: local(e.startTimestamp),
    stato: e.status?.description, stato_tipo: e.status?.type,
    casa_id: e.homeTeam?.id, casa: e.homeTeam?.name, casa_breve: e.homeTeam?.shortName,
    ospite_id: e.awayTeam?.id, ospite: e.awayTeam?.name, ospite_breve: e.awayTeam?.shortName,
    gol_casa: e.homeScore?.current, gol_ospite: e.awayScore?.current,
    casa_1T: e.homeScore?.period1, ospite_1T: e.awayScore?.period1,
    casa_rigori: e.homeScore?.penalties, ospite_rigori: e.awayScore?.penalties,
    vincitore: e.winnerCode === 1 ? 'casa' : e.winnerCode === 2 ? 'ospite' : e.winnerCode === 3 ? 'pareggio' : null,
    stadio: e.venue?.stadium?.name, venue_id: e.venue?.id, citta: e.venue?.city?.name, capienza: e.venue?.stadium?.capacity,
    arbitro: e.referee?.name, arbitro_id: e.referee?.id,
    fonte: 'sofascore', aggiornato: NOW, ...extra,
  };
}

async function processEvent(base, label, out) {
  const id = base.id;
  const errBefore = errors.length;
  const d = await sofa(`/event/${id}`);
  const e = d?.event || base;
  const type = e.status?.type; // notstarted | inprogress | finished | postponed | canceled ...
  const extra = {};

  if (type === 'finished' || type === 'inprogress') {
    const [lu, st, inc, mg, h2h] = await Promise.all([
      sofa(`/event/${id}/lineups`), sofa(`/event/${id}/statistics`), sofa(`/event/${id}/incidents`),
      sofa(`/event/${id}/managers`), sofa(`/event/${id}/h2h`),
    ]);
    extra.allenatore_casa = mg?.homeManager?.name; extra.allenatore_casa_id = mg?.homeManager?.id;
    extra.allenatore_ospite = mg?.awayManager?.name; extra.allenatore_ospite_id = mg?.awayManager?.id;
    extra.h2h_vitt_casa = h2h?.teamDuel?.homeWins; extra.h2h_vitt_ospite = h2h?.teamDuel?.awayWins; extra.h2h_pareggi = h2h?.teamDuel?.draws;

    if (lu) {
      extra.formazione_ufficiale = lu.confirmed === true ? 'SI' : lu.confirmed === false ? 'NO (probabile)' : null;
      extra.modulo_casa = lu.home?.formation; extra.modulo_ospite = lu.away?.formation;
      for (const side of ['home', 'away']) {
        for (const p of lu[side]?.players || []) {
          out.Formazioni.push({
            chiave: `${id}|${p.player?.id}`, eventId: id, lato: side === 'home' ? 'casa' : 'ospite',
            giocatore_id: p.player?.id, giocatore: p.player?.name, ruolo: p.position || p.player?.position,
            maglia: p.shirtNumber ?? p.jerseyNumber, titolare: p.substitute ? 'NO' : 'SI', capitano: p.captain ? 'SI' : '',
            minuti: p.statistics?.minutesPlayed, voto: p.statistics?.rating, gol: p.statistics?.goals, assist: p.statistics?.goalAssist,
            fonte: 'sofascore', aggiornato: NOW,
          });
        }
        for (const m of lu[side]?.missingPlayers || []) {
          out.Indisponibili.push({
            chiave: `${id}|${m.player?.id}`, eventId: id, lato: side === 'home' ? 'casa' : 'ospite',
            giocatore_id: m.player?.id, giocatore: m.player?.name, tipo: m.type, motivo: m.reason,
            fonte: 'sofascore', aggiornato: NOW,
          });
        }
      }
    }
    for (const per of st?.statistics || []) {
      for (const g of per.groups || []) {
        for (const it of g.statisticsItems || []) {
          out.Statistiche.push({
            chiave: `${id}|${per.period}|${it.key}`, eventId: id, periodo: per.period, gruppo: g.groupName,
            statistica: it.name, chiave_stat: it.key, casa: it.home, ospite: it.away,
            valore_casa: it.homeValue, valore_ospite: it.awayValue, fonte: 'sofascore', aggiornato: NOW,
          });
        }
      }
    }
    (inc?.incidents || []).forEach((x, i) => {
      out.Episodi.push({
        chiave: `${id}|${x.id ?? i}`, eventId: id, ordine: i, tipo: x.incidentType, dettaglio: x.incidentClass,
        minuto: x.time, recupero: x.addedTime, lato: x.isHome === true ? 'casa' : x.isHome === false ? 'ospite' : null,
        giocatore: x.player?.name || x.playerIn?.name, giocatore_id: x.player?.id || x.playerIn?.id,
        esce: x.playerOut?.name, assist: x.assist1?.name, testo: x.text, risultato_dopo: x.homeScore != null ? `${x.homeScore}-${x.awayScore}` : null,
        fonte: 'sofascore', aggiornato: NOW,
      });
    });
  }
  const completo = type === 'finished' && errors.length === errBefore;
  out.Partite.push(eventRow(e, label, { ...extra, dettagli: completo ? 'SI' : '' }));
}

async function main() {
  const out = { Squadre: [], Rosa: [], Competizioni: [], Partite: [], Formazioni: [], Indisponibili: [], Statistiche: [], Episodi: [], Classifiche: [], Forma: [] };
  const done = new Set((await (await fetch(`${GAS_URL}?token=${encodeURIComponent(TOKEN)}&action=done`, { redirect: 'follow' })).json()).done || []);
  const toProcess = [];
  const tournaments = new Map(); // "ut|season" -> {ut, season, label, ts}

  for (const T of TEAMS) {
    console.log('Squadra', T.label);
    const t = (await sofa(`/team/${T.id}`))?.team;
    if (!t) console.warn(`  /team/${T.id} non ha restituito dati: verifica l'ID`);
    else out.Squadre.push({
      chiave: String(t.id), team_id: t.id, etichetta: T.label, nome: t.name, nome_breve: t.shortName, paese: t.country?.name,
      citta: t.venue?.city?.name, stadio: t.venue?.stadium?.name, allenatore: t.manager?.name, allenatore_id: t.manager?.id,
      fondazione: iso(t.foundationDateTimestamp), colore1: t.teamColors?.primary, colore2: t.teamColors?.secondary, fonte: 'sofascore', aggiornato: NOW,
    });

    for (const p of (await sofa(`/team/${T.id}/players`))?.players || []) {
      const pl = p.player || {};
      out.Rosa.push({
        chiave: `${T.id}|${pl.id}`, team_id: T.id, squadra_como: T.label, giocatore_id: pl.id, nome: pl.name, ruolo: pl.position,
        maglia: pl.jerseyNumber, nazionalita: pl.country?.name, nascita: iso(pl.dateOfBirthTimestamp), altezza: pl.height, piede: pl.preferredFoot,
        fonte: 'sofascore', aggiornato: NOW,
      });
    }

    const events = [];
    for (const dir of [['last', 40], ['next', 6]]) {
      for (let page = 0; page < dir[1]; page++) {
        const r = await sofa(`/team/${T.id}/events/${dir[0]}/${page}`);
        events.push(...(r?.events || []));
        if (!r || !r.hasNextPage) break;
      }
    }
    const uniq = [...new Map(events.map((e) => [e.id, e])).values()];
    console.log(`  ${uniq.length} partite trovate`);

    for (const e of uniq) {
      const ut = e.tournament?.uniqueTournament?.id, s = e.season?.id;
      if (ut && s) {
        const k = `${ut}|${s}`, prev = tournaments.get(k);
        if (!prev || e.startTimestamp > prev.ts) tournaments.set(k, { ut, season: s, tid: e.tournament?.id, label: T.label, ts: e.startTimestamp });
      }
      if (!done.has(String(e.id))) toProcess.push({ e, label: T.label });
    }

    // forma recente calcolata dai risultati reali
    const fin = uniq.filter((e) => e.status?.type === 'finished').sort((a, b) => b.startTimestamp - a.startTimestamp).slice(0, 10);
    const esito = (e) => {
      const home = e.homeTeam?.id === T.id, w = e.winnerCode;
      if (w === 3) return 'P';
      return (w === 1 && home) || (w === 2 && !home) ? 'V' : 'S';
    };
    out.Forma.push({ chiave: String(T.id), team_id: T.id, squadra_como: T.label, ultime5: fin.slice(0, 5).map(esito).join(''), ultime10: fin.map(esito).join(''), aggiornato: NOW, fonte: 'sofascore' });
  }

  // competizioni, stagioni e classifiche (snapshot giornaliero = storico prepartita)
  for (const { ut, season, tid, label } of tournaments.values()) {
    const ss = await sofa(`/unique-tournament/${ut}/seasons`);
    for (const s of ss?.seasons || []) out.Competizioni.push({ chiave: `${ut}|${s.id}`, competizione_id: ut, stagione_id: s.id, stagione: s.name, anno: s.year, fonte: 'sofascore', aggiornato: NOW });
    const st = (await sofa(`/unique-tournament/${ut}/season/${season}/standings/total`)) || (await sofa(`/tournament/${tid}/season/${season}/standings/total`));
    for (const g of st?.standings || []) {
      for (const r of g.rows || []) {
        out.Classifiche.push({
          chiave: `${ut}|${season}|${r.team?.id}|${NOW.slice(0, 10)}`, data_snapshot: NOW.slice(0, 10), competizione_id: ut, stagione_id: season,
          girone: g.name, posizione: r.position, team_id: r.team?.id, squadra: r.team?.name, giocate: r.matches, vinte: r.wins, pareggi: r.draws,
          perse: r.losses, gol_fatti: r.scoresFor, gol_subiti: r.scoresAgainst, punti: r.points, fonte: 'sofascore', aggiornato: NOW,
        });
      }
    }
  }

  // partite: prima quelle non concluse / vicine, poi le concluse più recenti
  toProcess.sort((a, b) => (a.e.status?.type === 'finished') - (b.e.status?.type === 'finished') || Math.abs(a.e.startTimestamp - Date.now() / 1000) - Math.abs(b.e.startTimestamp - Date.now() / 1000));
  for (const { e, label } of toProcess.slice(0, MAX_EVENTS)) await processEvent(e, label, out);
  console.log(`Partite approfondite: ${Math.min(MAX_EVENTS, toProcess.length)} su ${toProcess.length} da completare`);

  for (const [sheet, rows] of Object.entries(out)) await push(sheet, rows);
  await push('Log', [{ chiave: NOW, eseguito: NOW, errori: errors.length, bloccate_403_429: blocked, dettaglio: JSON.stringify(errors.slice(0, 25)), partite_ancora_da_completare: Math.max(0, toProcess.length - MAX_EVENTS) }]);
  if (errors.length) console.warn(`${errors.length} richieste fallite, vedi foglio Log`);
}

main().catch(async (e) => {
  console.error(e.message);
  try { await push('Log', [{ chiave: NOW, eseguito: NOW, errori: errors.length, bloccate_403_429: blocked, dettaglio: e.message + ' ' + JSON.stringify(errors.slice(0, 15)) }]); } catch {}
  process.exit(1);
});
