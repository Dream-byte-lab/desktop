// The guest page: the whole of what a party guest ever installs —
// nothing. The host app serves this single self-contained page over
// the local Wi-Fi; a guest opens it from the host's join link (the
// QR code carries tonight's join secret in its `#join=` fragment),
// trades that secret for an anonymous token kept in their own
// browser, searches tonight's catalogue AND — since Step 6, per
// Note 5's ruling — the programme's whole search, requests songs,
// watches honest statuses come back, and taps reactions. No
// account, no app, no sign-in, and no powers beyond asking:
// guests cannot skip, stop, reorder or touch the volume.
//
// The page is built with plain DOM calls and textContent throughout,
// so titles from the host's library can never inject markup.

export function guestPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>liveRave — request a song</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0b0b10; color: #f2f2f5; }
  main { max-width: 560px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  .sub { color: #a7a7b3; font-size: 13px; margin-bottom: 18px; }
  .card { background: #17171f; border: 1px solid #26262f; border-radius: 14px; padding: 14px; margin-bottom: 14px; }
  .label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #a7a7b3; margin-bottom: 6px; }
  .title { font-size: 17px; font-weight: 600; }
  .artist { color: #a7a7b3; font-size: 14px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-bottom: 1px solid #23232c; }
  .row:last-child { border-bottom: none; }
  button { background: #6d5cff; color: white; border: none; border-radius: 999px; padding: 8px 14px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { background: #33333f; color: #8a8a96; cursor: default; }
  input[type="search"] { width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid #2c2c38; background: #101018; color: #f2f2f5; font-size: 15px; margin-bottom: 6px; }
  .chip { font-size: 12px; font-weight: 600; padding: 4px 9px; border-radius: 999px; background: #26262f; color: #cfcfe0; white-space: nowrap; }
  .chip.soon { background: #14532d; color: #bbf7d0; }
  .chip.no { background: #4c1d1d; color: #fecaca; }
  .reactions { display: flex; gap: 10px; }
  .reactions button { flex: 1; background: #1e1e28; font-size: 19px; padding: 10px 0; }
  .note { color: #8a8a96; font-size: 12px; line-height: 1.5; }
  .hidden { display: none; }
  #toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: #23232e; border: 1px solid #343442; color: #f2f2f5; padding: 10px 16px; border-radius: 999px; font-size: 14px; opacity: 0; transition: opacity 0.25s; pointer-events: none; max-width: 90vw; text-align: center; }
</style>
</head>
<body>
<main>
  <h1 id="party-name">liveRave</h1>
  <div class="sub">Request a song — the DJ weighs every request against the night.</div>

  <div id="closed" class="card hidden">
    <div class="title">The party hasn't started yet</div>
    <div class="artist">Hang tight — this page wakes up when the host opens the party.</div>
  </div>

  <div id="live" class="hidden">
    <div id="paused" class="card hidden">
      <div class="title">Requests are paused</div>
      <div class="artist">The host has paused new requests for a bit — the music keeps playing.</div>
    </div>
    <div class="card">
      <div class="label">Now playing</div>
      <div class="title" id="now-title">—</div>
      <div class="artist" id="now-artist"></div>
      <div class="label" style="margin-top:12px">Up next</div>
      <div id="up-next"></div>
    </div>

    <div class="card">
      <div class="label">React</div>
      <div class="reactions">
        <button data-react="fire" aria-label="Fire">🔥</button>
        <button data-react="heart" aria-label="Love it">❤️</button>
        <button data-react="clap" aria-label="Applause">👏</button>
      </div>
    </div>

    <div class="card" id="mine-card">
      <div class="label">Your requests</div>
      <div id="mine"></div>
    </div>

    <div class="card">
      <div class="label">Tonight's songs</div>
      <input type="search" id="search" placeholder="Search tonight's songs…" />
      <div id="catalogue"></div>
    </div>

    <div class="card">
      <div class="label">Search the whole programme</div>
      <input type="search" id="prog-search" placeholder="Any song, any artist…" />
      <div id="prog-results">
        <div class="artist">Can't find it in tonight's songs? Search everything — if the programme can find it, you can ask for it.</div>
      </div>
    </div>

    <p class="note">Requests aren't a queue-jump: the DJ fits each one where it
    belongs in the night. “Coming soon” means it fits. “Waiting for its moment”
    means it belongs later — a big song asked for early gets held for its moment,
    not wasted.</p>
  </div>
</main>
<div id="toast"></div>
<script>
(function () {
  var tokenKey = "liverave-guest-token";
  var joinKey = "liverave-join-secret";
  var token = localStorage.getItem(tokenKey);
  var catalogue = [];
  var searchResults = [];
  var searchTimer = null;
  var searchSeq = 0;
  var myRequests = [];
  var acceptingRequests = true;

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function toast(message) {
    var t = document.getElementById("toast");
    t.textContent = message;
    t.style.opacity = "1";
    setTimeout(function () { t.style.opacity = "0"; }, 2600);
  }
  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
    });
  }
  // Tonight's join secret rides in this page's own address, after
  // the "#" — the host's QR code put it there. It never travels in
  // a request URL; the page presents it once, in the mint call's
  // body, and the server trades it for the guest token.
  var joinSecret = (function () {
    var match = /join=([^&]+)/.exec(location.hash || "");
    if (match) {
      var secret = decodeURIComponent(match[1]);
      localStorage.setItem(joinKey, secret);
      return secret;
    }
    return localStorage.getItem(joinKey) || "";
  })();
  function mintToken() {
    return api("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ join: joinSecret }),
    }).then(function (res) {
      if (res.ok && res.body.token) {
        token = res.body.token;
        localStorage.setItem(tokenKey, token);
        return token;
      }
      return null;
    });
  }
  function ensureToken() {
    if (token) return Promise.resolve(token);
    return mintToken();
  }
  function dropToken() {
    token = null;
    localStorage.removeItem(tokenKey);
  }
  // Calls an authenticated endpoint with the guest token in the
  // body. A 401 means the stored token is dead (last night's party,
  // most likely): drop it, mint a fresh one from tonight's join
  // secret, and try exactly once more.
  function callWithToken(path, payload) {
    function attempt() {
      return ensureToken().then(function (guestToken) {
        if (!guestToken) {
          return {
            ok: false,
            status: 403,
            body: { error: "Couldn't join — scan the host's QR code" },
          };
        }
        var body = { token: guestToken };
        Object.keys(payload).forEach(function (key) { body[key] = payload[key]; });
        return api(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      });
    }
    return attempt().then(function (res) {
      if (res.status !== 401) return res;
      dropToken();
      return attempt();
    });
  }
  function chipFor(status) {
    var chip = el("span", status, "chip");
    if (status === "coming soon" || status === "played") chip.classList.add("soon");
    if (status === "not tonight") chip.classList.add("no");
    return chip;
  }
  function renderState(state) {
    document.getElementById("party-name").textContent = state.partyName || "liveRave";
    document.getElementById("closed").classList.toggle("hidden", state.open);
    document.getElementById("live").classList.toggle("hidden", !state.open);
    if (!state.open) return;
    acceptingRequests = state.accepting !== false;
    document.getElementById("paused").classList.toggle("hidden", acceptingRequests);
    document.getElementById("now-title").textContent = state.nowPlaying ? state.nowPlaying.title : "—";
    document.getElementById("now-artist").textContent = state.nowPlaying ? state.nowPlaying.artist : "";
    var upNext = document.getElementById("up-next");
    upNext.textContent = "";
    (state.upNext || []).slice(0, 3).forEach(function (track) {
      var row = el("div", null, "row");
      var left = el("div");
      left.appendChild(el("div", track.title));
      left.appendChild(el("div", track.artist, "artist"));
      row.appendChild(left);
      if (track.requested) {
        row.appendChild(el("span", "Guest request", "chip soon"));
      }
      upNext.appendChild(row);
    });
    if (!state.upNext || state.upNext.length === 0) {
      upNext.appendChild(el("div", "The DJ is choosing…", "artist"));
    }
    myRequests = state.myRequests || [];
    var mine = document.getElementById("mine");
    mine.textContent = "";
    if (myRequests.length === 0) {
      mine.appendChild(el("div", "Nothing yet — ask for something below.", "artist"));
    }
    myRequests.forEach(function (req) {
      var row = el("div", null, "row");
      var left = el("div");
      left.appendChild(el("div", req.title || req.trackId));
      left.appendChild(el("div", req.artist || "", "artist"));
      left.appendChild(el("div",
        req.source === "search" ? "via programme search" : "from tonight's songs",
        "artist"));
      row.appendChild(left);
      row.appendChild(chipFor(req.status));
      mine.appendChild(row);
    });
    renderCatalogue();
    renderSearchResults();
  }
  function renderCatalogue() {
    var query = document.getElementById("search").value.trim().toLowerCase();
    var list = document.getElementById("catalogue");
    list.textContent = "";
    var openIds = {};
    myRequests.forEach(function (req) {
      if (req.status !== "not tonight" && req.status !== "played") openIds[req.trackId] = true;
    });
    catalogue
      .filter(function (track) {
        if (!query) return true;
        return (track.title + " " + track.artist).toLowerCase().indexOf(query) !== -1;
      })
      .slice(0, 60)
      .forEach(function (track) {
        var row = el("div", null, "row");
        var left = el("div");
        left.appendChild(el("div", track.title));
        left.appendChild(el("div", track.artist, "artist"));
        row.appendChild(left);
        var button = el("button", openIds[track.id] ? "Requested" : "Request");
        button.disabled = Boolean(openIds[track.id]) || !acceptingRequests;
        button.addEventListener("click", function () { requestTrack(track, button); });
        row.appendChild(button);
        list.appendChild(row);
      });
    if (list.childElementCount === 0) {
      list.appendChild(el("div", "No songs match that search tonight.", "artist"));
    }
  }
  function requestTrack(track, button) {
    button.disabled = true;
    callWithToken("/api/request", { trackId: track.id }).then(function (res) {
      if (res.ok) {
        toast(res.body.duplicate ? "Counted as a vote for that song" : "Request received");
      } else {
        toast(res.body.error || "That request didn't go through");
        button.disabled = false;
      }
      refresh();
    }).catch(function () {
      toast("Couldn't reach the party — check the Wi-Fi");
      button.disabled = false;
    });
  }
  function openRequestIds() {
    var openIds = {};
    myRequests.forEach(function (req) {
      if (req.status !== "not tonight" && req.status !== "played") openIds[req.trackId] = true;
    });
    return openIds;
  }
  function renderSearchResults() {
    var list = document.getElementById("prog-results");
    if (!list) return;
    var query = document.getElementById("prog-search").value.trim();
    list.textContent = "";
    if (query.length < 2) {
      list.appendChild(el("div", "Can't find it in tonight's songs? Search everything — if the programme can find it, you can ask for it.", "artist"));
      return;
    }
    var openIds = openRequestIds();
    searchResults.forEach(function (track) {
      var row = el("div", null, "row");
      var left = el("div");
      left.appendChild(el("div", track.title));
      left.appendChild(el("div", track.artist, "artist"));
      row.appendChild(left);
      row.appendChild(el("span", "Programme", "chip"));
      var button = el("button", openIds[track.id] ? "Requested" : "Request");
      button.disabled = Boolean(openIds[track.id]) || !acceptingRequests;
      button.addEventListener("click", function () { requestTrack(track, button); });
      row.appendChild(button);
      list.appendChild(row);
    });
    if (list.childElementCount === 0) {
      list.appendChild(el("div", "The programme couldn't find that — try another spelling.", "artist"));
    }
  }
  function runProgrammeSearch() {
    var query = document.getElementById("prog-search").value.trim();
    if (query.length < 2) {
      searchResults = [];
      renderSearchResults();
      return;
    }
    var seq = ++searchSeq;
    callWithToken("/api/search", { query: query }).then(function (res) {
      if (seq !== searchSeq) return;
      if (res.ok) {
        searchResults = res.body.tracks || [];
      } else {
        searchResults = [];
        toast(res.body.error || "Search didn't go through");
      }
      renderSearchResults();
    }).catch(function () {
      if (seq !== searchSeq) return;
      searchResults = [];
      renderSearchResults();
    });
  }
  function refresh() {
    // The token goes in a header, never in the polled URL.
    var options = token ? { headers: { "x-party-token": token } } : undefined;
    api("/api/state", options).then(function (res) { renderState(res.body); }).catch(function () {});
  }
  function loadCatalogue() {
    api("/api/catalogue").then(function (res) {
      catalogue = res.body.tracks || [];
      renderCatalogue();
    }).catch(function () {});
  }
  document.getElementById("search").addEventListener("input", renderCatalogue);
  document.getElementById("prog-search").addEventListener("input", function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runProgrammeSearch, 400);
  });
  document.querySelectorAll("[data-react]").forEach(function (button) {
    button.addEventListener("click", function () {
      callWithToken("/api/react", { kind: button.getAttribute("data-react") })
        .then(function (res) {
          toast(res.ok ? "Sent to the DJ" : res.body.error || "That didn't go through");
        })
        .catch(function () {});
    });
  });
  ensureToken().then(function () {
    refresh();
    loadCatalogue();
  });
  setInterval(refresh, 5000);
  setInterval(loadCatalogue, 30000);
})();
</script>
</body>
</html>`;
}
