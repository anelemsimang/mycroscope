const PLANS = ["free", "work_activity", "workforce", "productivity"];
const root = document.querySelector("#checkout-root");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/** A failed request often returns { error: { message } }. Printing that object shows "[object Object]". */
function textFrom(value, fallback = "") {
  if (typeof value === "string" && value.trim() && value !== "[object Object]") return value.trim();
  if (value && typeof value === "object") {
    for (const key of ["message", "error", "msg", "error_description", "details", "hint"]) {
      const inner = value[key];
      if (typeof inner === "string" && inner.trim() && inner !== "[object Object]") return inner.trim();
      if (inner && typeof inner === "object") {
        const deeper = inner.message || inner.error || inner.msg;
        if (typeof deeper === "string" && deeper.trim()) return deeper.trim();
      }
    }
  }
  return fallback;
}

function rands(cents) {
  const amount = Number(cents) / 100;
  const text = new Intl.NumberFormat("en-ZA", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `R${text.replace(/\u00a0/g, ",").replace(/ /g, ",")}`;
}

function planFromAddress() {
  const plan = new URLSearchParams(location.search).get("plan");
  return PLANS.includes(plan) ? plan : "";
}

function show(html) {
  root.innerHTML = html;
}

function rememberReturn(path) {
  sessionStorage.setItem("mycroscope-checkout-next", JSON.stringify({ path, at: Date.now() }));
}

function seatsFromAddress() {
  const raw = new URLSearchParams(location.search).get("seats");
  const seats = Number(raw);
  return Number.isInteger(seats) && seats >= 1 && seats <= 10000 ? seats : 1;
}

function whenFromAddress() {
  return new URLSearchParams(location.search).get("when") === "end" ? "end" : "now";
}

function signedOut(plan, seats) {
  const timing = whenFromAddress() === "end" ? "&when=end" : "";
  const returnPath = `/checkout?plan=${plan}&seats=${seats}${timing}`;
  const signIn = `/sign-in?next=${encodeURIComponent(returnPath)}`;
  const signUp = `/sign-up?next=${encodeURIComponent(returnPath)}`;
  show(`<p>Sign in as the organisation manager to pay. The card number is entered on Yoco's page, not on Mycroscope.</p>
    <p><a class="button" id="sign-in-pay" href="${esc(signIn)}">Sign in to pay</a></p>
    <p><a id="create-account" href="${esc(signUp)}">Create an account</a></p>`);
  for (const id of ["sign-in-pay", "create-account"]) {
    document.getElementById(id)?.addEventListener("click", () => rememberReturn(returnPath));
  }
}

async function start() {
  const plan = planFromAddress();
  const cfg = window.MYCROSCOPE_BILLING;
  if (!cfg?.url || !cfg?.anonKey) {
    show(`<p class="banner error">Online payment is not set up on this copy of the site.</p>`);
    return;
  }
  if (!plan) {
    show(`<p>Choose a plan on the <a href="/pricing">pricing page</a>. Payment is taken on this website, and the card form is on Yoco's secure page.</p>
      <p><a class="button" href="/pricing">View plans</a></p>`);
    return;
  }
  if (plan === "free") {
    show(`<p>Free has no charge. Create the organisation, then invite people from the dashboard.</p>
      <p><a class="button" href="/sign-up">Create an account</a></p>`);
    return;
  }

  let createClient;
  try {
    ({ createClient } = await import("./supabase.js"));
  } catch {
    show(`<p class="banner error">Online payment is not set up on this copy of the site.</p>`);
    return;
  }
  const supabase = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const { data: sessionData } = await supabase.auth.getSession();
  if (userError || !userData.user || !sessionData.session) {
    signedOut(plan, seatsFromAddress());
    return;
  }

  let ticket = 0;
  async function showQuote(seats) {
    const mine = ++ticket;
    const [{ data: catalogue, error: catalogueError }, { data: quote, error: quoteError }] = await Promise.all([
      supabase.rpc("get_plan_catalogue"),
      supabase.rpc("quote_plan_change", { p_plan: plan, p_commit: false, p_seats: seats, p_when: whenFromAddress() }),
    ]);
    if (mine !== ticket) return;
  if (catalogueError || quoteError || !quote) {
    const raw = textFrom(quoteError, "") || textFrom(catalogueError, "") || "The order could not be prepared.";
    const message = raw.replace(/\bOwners\b/g, "Managers").replace(/\bowners\b/g, "managers").replace(/\bOwner\b/g, "Manager").replace(/\bowner\b/g, "manager");
    const accountHolder = /\bowners?\b/i.test(raw);
    const timing = whenFromAddress() === "end" ? "&when=end" : "";
    const returnPath = `/checkout?plan=${plan}&seats=${seats}${timing}`;
    const signIn = `/sign-in?next=${encodeURIComponent(returnPath)}`;
    show(`<p class="banner error">${esc(message)}</p>
      ${accountHolder ? `<p><a href="/overview">Back to the dashboard</a></p>` : `<p><a id="sign-in-again" href="${esc(signIn)}">Sign in again</a></p>`}`);
    document.getElementById("sign-in-again")?.addEventListener("click", () => rememberReturn(returnPath));
    return;
  }

  const item = (catalogue ?? []).find((row) => row.key === plan);
  const name = item?.name ?? plan;
  const chosen = Number(quote.seats) || seats;
  const chooseSeats = quote.kind === "new" || quote.kind === "renewal" || quote.kind === "seats";
  const payable = Number(quote.gross_cents) > 0 && quote.kind !== "downgrade";
  const seatLabel = quote.kind === "seats" ? "New seats" : quote.kind === "upgrade" || quote.kind === "upgrade_later" ? "Seats already purchased" : "Seats";
  const rows = [
    ["Plan", name],
    [seatLabel, String(chosen)],
  ];
  if (item) {
    rows.push(["Monthly price", Number(item.net_price_cents) === 0 ? "No charge" : `${rands(item.net_price_cents)} per seat, before VAT`]);
  }
  if (Number(quote.credit_cents) > 0) {
    rows.push(["Unused current plan", rands(quote.credit_cents)]);
  }
  if (payable) {
    rows.push(["Before VAT", rands(quote.net_cents ?? 0)]);
    rows.push(["VAT", rands(quote.vat_cents ?? 0)]);
  }
  const list = rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("");
  const quantity = chooseSeats
    ? `<div class="seat-qty"><label for="seats">Seats</label>
         <input id="seats" type="number" min="${esc(quote.min_seats || 1)}" max="10000" value="${esc(chosen)}" inputmode="numeric">
       </div>`
    : "";
  const later = quote.kind === "upgrade"
    ? `<button class="button button-ghost" id="later" type="button">Start when this term ends</button>`
    : "";
  const action = payable
    ? `<p class="due">${esc(rands(quote.gross_cents))}</p>
       <div class="actions">
         <button class="button" id="pay" type="button">${quote.kind === "upgrade" ? "Start today" : "Continue to secure payment"}</button>
         ${later}
       </div>`
    : quote.kind === "downgrade"
      ? `<p><a class="button" href="/billing">Schedule this in the dashboard</a></p>`
      : `<p><a class="button" href="/billing">Back to billing</a></p>`;

  show(`<h2>${esc(name)}</h2>
    ${quantity}
    <dl>${list}</dl>
    ${quote.message ? `<p>${esc(textFrom(quote.message))}</p>` : ""}
    <p class="fine">${quote.kind === "upgrade_later"
      ? "You pay on Yoco's secure page. Mycroscope does not see the card number. The current plan stays until the date in the summary. The new plan starts then. If this payment is not made, the change does not start."
      : quote.kind === "upgrade"
        ? "Start today is paid on Yoco's secure page. Every seat then ends one year from today. Start when this term ends charges nothing now. The new year is due before that date, and the change does not start if it is not paid."
        : "You pay on Yoco's secure page. Mycroscope does not see the card number. Coming back to this site is not proof of payment. The plan changes when the payment is confirmed."
    } Paying agrees to the <a href="/terms">terms of service</a>.</p>
    ${action}`);

  document.querySelector("#seats")?.addEventListener("change", (event) => {
    const next = Number(event.target.value);
    if (!Number.isInteger(next) || next < 1 || next > 10000 || next === chosen) return;
    const url = new URL(location.href);
    url.searchParams.set("seats", String(next));
    history.replaceState(null, "", url);
    showQuote(next);
  });

  document.querySelector("#pay")?.addEventListener("click", async () => {
    const button = document.querySelector("#pay");
    if (!button) return;
    button.disabled = true;
    button.textContent = "Opening the payment page…";
    try {
      const { data: fresh } = await supabase.auth.getSession();
      const token = fresh.session?.access_token;
      if (!token) {
        signedOut(plan, chosen);
        return;
      }
      const origin = location.origin;
      const q = encodeURIComponent(plan);
      const response = await fetch(`${cfg.url.replace(/\/+$/, "")}/functions/v1/yoco-checkout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: cfg.anonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          plan,
          seats: chosen,
          when: whenFromAddress(),
          return_url: `${origin}/checkout-received?plan=${q}`,
          cancel_url: `${origin}/checkout-cancelled?plan=${q}`,
          failure_url: `${origin}/checkout-failed?plan=${q}`,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        show(`<p class="banner error">${esc(textFrom(body.error, "") || textFrom(body, "") || "The payment could not be started.")}</p><p><a href="${esc(location.pathname + location.search)}">Try again</a></p>`);
        return;
      }
      if (!body.redirect_url) {
        show(`<p>${esc(textFrom(body.message, "") || "No payment is due.")}</p><p><a class="button" href="/billing">Back to billing</a></p>`);
        return;
      }
      location.assign(body.redirect_url);
    } catch {
      show(`<p class="banner error">The payment page could not be opened. Check your connection and try again.</p><p><a href="${esc(location.pathname + location.search)}">Try again</a></p>`);
    }
  });

  document.querySelector("#later")?.addEventListener("click", async () => {
    const button = document.querySelector("#later");
    if (!button) return;
    button.disabled = true;
    button.textContent = "Scheduling…";
    const { data, error } = await supabase.rpc("quote_plan_change", {
      p_plan: plan, p_commit: true, p_seats: chosen, p_when: "schedule",
    });
    if (error) {
      show(`<p class="banner error">${esc(textFrom(error, "") || "The upgrade could not be scheduled.")}</p><p><a href="${esc(location.pathname + location.search)}">Try again</a></p>`);
      return;
    }
    show(`<p>${esc(textFrom(data?.message, "") || "The upgrade is scheduled. Nothing is charged today.")}</p>
      <p>Pay for the new year from billing before that date. If it is not paid, the change does not start.</p>
      <p><a class="button" href="/billing">Back to billing</a></p>`);
  });
  }

  await showQuote(seatsFromAddress());
}

start().catch((error) => {
  show(`<p class="banner error">${esc(textFrom(error, "") || "The payment page could not be opened.")}</p>`);
});
