const PLANS = ["free", "work_activity", "workforce", "productivity"];
const root = document.querySelector("#checkout-root");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
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

function signedOut(plan, seats) {
  const returnPath = `/checkout?plan=${plan}&seats=${seats}`;
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
      supabase.rpc("quote_plan_change", { p_plan: plan, p_commit: false, p_seats: seats }),
    ]);
    if (mine !== ticket) return;
  if (catalogueError || quoteError || !quote) {
    const raw = quoteError?.message || catalogueError?.message || "The order could not be prepared.";
    const message = raw.replace(/\bOwners\b/g, "Managers").replace(/\bowners\b/g, "managers").replace(/\bOwner\b/g, "Manager").replace(/\bowner\b/g, "manager");
    const accountHolder = /\bowners?\b/i.test(raw);
    const returnPath = `/checkout?plan=${plan}&seats=${seats}`;
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
  const seatLabel = quote.kind === "seats" ? "New seats" : quote.kind === "upgrade" ? "Seats already purchased" : "Seats";
  const rows = [
    ["Plan", name],
    [seatLabel, String(chosen)],
  ];
  if (item) {
    rows.push(["Monthly price", Number(item.net_price_cents) === 0 ? "No charge" : `${rands(item.net_price_cents)} per seat, before VAT`]);
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
  const action = payable
    ? `<p class="due">${esc(rands(quote.gross_cents))}</p>
       <button class="button" id="pay" type="button">Continue to secure payment</button>`
    : quote.kind === "downgrade"
      ? `<p><a class="button" href="/billing">Schedule this in the dashboard</a></p>`
      : `<p><a class="button" href="/billing">Back to billing</a></p>`;

  show(`<h2>${esc(name)}</h2>
    ${quantity}
    <dl>${list}</dl>
    ${quote.message ? `<p>${esc(quote.message)}</p>` : ""}
    <p class="fine">You pay on Yoco's secure page. Mycroscope does not see the card number. Coming back to this site is not proof of payment. The plan changes when the payment is confirmed. Paying agrees to the <a href="/terms">terms of service</a>.</p>
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
          return_url: `${origin}/checkout-received?plan=${q}`,
          cancel_url: `${origin}/checkout-cancelled?plan=${q}`,
          failure_url: `${origin}/checkout-failed?plan=${q}`,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        show(`<p class="banner error">${esc(body.error || "The payment could not be started.")}</p><p><a href="${esc(location.pathname + location.search)}">Try again</a></p>`);
        return;
      }
      if (!body.redirect_url) {
        show(`<p>${esc(body.message || "No payment is due.")}</p><p><a class="button" href="/billing">Back to billing</a></p>`);
        return;
      }
      location.assign(body.redirect_url);
    } catch {
      show(`<p class="banner error">The payment page could not be opened. Check your connection and try again.</p><p><a href="${esc(location.pathname + location.search)}">Try again</a></p>`);
    }
  });
  }

  await showQuote(seatsFromAddress());
}

start().catch((error) => {
  show(`<p class="banner error">${esc(error?.message || "The payment page could not be opened.")}</p>`);
});
