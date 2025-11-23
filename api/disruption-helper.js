<script>
  // ========= CONFIG =========
  // IMPORTANT:
  // This HTML is a FRONTEND ONLY. DO NOT put your Gemini or flight API keys here.
  // Instead, point API_BASE_URL to your backend (Vercel) that holds the keys.
  const API_BASE_URL = "https://flight-disruption-helper.vercel.app";

  const form = document.getElementById("disruption-form");
  const resultsEl = document.getElementById("results");
  const loadingEl = document.getElementById("loadingIndicator");
  const submitBtn = document.getElementById("submitBtn");
  const resetBtn = document.getElementById("resetBtn");
  const errorEl = document.getElementById("error");
  const issueTypeEl = document.getElementById("issueType");
  const delayRowEl = document.getElementById("delay-row");

  // Show/hide delay field based on issue type
  issueTypeEl.addEventListener("change", () => {
    const type = issueTypeEl.value;
    if (!type || type === "cancellation") {
      delayRowEl.style.display = "none";
      document.getElementById("delayMinutes").value = "";
    } else {
      delayRowEl.style.display = "grid";
    }
  });
  // Initialize
  delayRowEl.style.display = "none";

  resetBtn.addEventListener("click", () => {
    form.reset();
    errorEl.style.display = "none";
    delayRowEl.style.display = "none";
    resultsEl.innerHTML = `
      <div class="results-empty">
        Fill in your flight details and click
        <strong>Analyze disruption</strong> to see:
        <ul style="margin: 6px 0 0 16px; padding: 0; font-size: 0.82rem;">
          <li>Compensation / refund likelihood</li>
          <li>Suggested next-best options</li>
          <li>Ready-made messages you can copy</li>
        </ul>
      </div>
    `;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.style.display = "none";
    errorEl.textContent = "";
    setLoading(true);

    const formData = new FormData(form);
    const payload = {
      from: formData.get("from")?.trim() || "",
      to: formData.get("to")?.trim() || "",
      airline: formData.get("airline")?.trim() || "",
      flightNumber: formData.get("flightNumber")?.trim() || "",
      flightDate: formData.get("flightDate") || "",
      issueType: formData.get("issueType") || "",
      delayMinutes: formData.get("delayMinutes")
        ? Number(formData.get("delayMinutes"))
        : null,
      cause: formData.get("cause") || "",
      region: formData.get("region") || "",
      priority: formData.get("priority") || "earliest",
      extraContext: formData.get("extraContext")?.trim() || "",
    };

    if (
      !payload.from ||
      !payload.to ||
      !payload.airline ||
      !payload.flightNumber ||
      !payload.flightDate ||
      !payload.issueType
    ) {
      showError("Please fill all required fields before analyzing.");
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(API_BASE_URL + "/api/disruption-helper", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Failed to reach disruption helper API.");
      }

      const data = await response.json();
      renderResults(data);
    } catch (err) {
      console.error(err);
      showError(
        "Sorry, something went wrong while analyzing your flight. Please try again in a moment."
      );
    } finally {
      setLoading(false);
    }
  });

  function setLoading(isLoading) {
    loadingEl.style.display = isLoading ? "inline-flex" : "none";
    submitBtn.disabled = isLoading;
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = "block";
  }

  // ====== RENDER RESULTS ======
  function renderResults(data) {
    const status = data.status || {};
    const eligibility = data.eligibility || {};
    const explanation = data.explanation || "";
    const options = Array.isArray(data.options) ? data.options : [];
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const hotels = Array.isArray(data.hotels) ? data.hotels : [];

    const disruptionLabel =
      status.disruptionType === "delay"
        ? "Delayed"
        : status.disruptionType === "cancellation"
        ? "Cancelled"
        : status.disruptionType === "missed_connection"
        ? "Missed connection"
        : "No disruption detected";

    const delayText =
      typeof status.delayMinutes === "number" && status.delayMinutes > 0
        ? `${status.delayMinutes} min delay`
        : "No delay reported";

    const eligibilityLabel = eligibility.label || "Unknown";
    const eligibilitySummary = eligibility.summary || "";

    // NEW: where did status data come from?
    const statusSource = status.source || "user";
    const sourceLabel =
      statusSource === "aerodatabox"
        ? "Status: Flight API"
        : "Status: What you entered";

    let statusHtml = `
      <div class="status-chip-row">
        <div class="status-chip">
          <span class="status-chip-dot"></span>
          <span>
            <strong>${escapeHtml(disruptionLabel)}</strong>
            ${
              status.flightNumber
                ? `· ${escapeHtml(status.flightNumber)}`
                : ""
            }
          </span>
        </div>
        ${
          status.route
            ? `<div class="status-chip">
                 <span>Route</span>
                 <strong>${escapeHtml(status.route)}</strong>
               </div>`
            : ""
        }
        <div class="status-chip">
          <span>Delay</span>
          <strong>${escapeHtml(delayText)}</strong>
        </div>
        <div class="status-chip">
          <span>Eligibility</span>
          <strong>${escapeHtml(eligibilityLabel)}</strong>
        </div>
        <div class="status-chip">
          <span>${escapeHtml(sourceLabel)}</span>
        </div>
      </div>
    `;

    let explanationHtml = `
      <section class="section">
        <div class="section-title">
          <span>Summary & typical rights</span>
          ${
            eligibilitySummary
              ? `<span class="sub">${escapeHtml(eligibilitySummary)}</span>`
              : ""
          }
        </div>
        <div class="section-body">
          ${
            explanation
              ? `<p>${nl2br(escapeHtml(explanation))}</p>`
              : `<p>We could not generate a detailed explanation this time.</p>`
          }
        </div>
      </section>
    `;

    let optionsHtml = "";
    if (options.length) {
      const items = options
        .map((opt) => {
          const title = opt.title || "Option";
          const desc = opt.description || "";
          return `
            <li>
              <strong>${escapeHtml(title)}</strong>
              ${
                desc
                  ? `<span>${nl2br(escapeHtml(desc))}</span>`
                  : ""
              }
            </li>
          `;
        })
        .join("");
      optionsHtml = `
        <section class="section">
          <div class="section-title">
            <span>Suggested next-best options</span>
            <span class="sub">Evaluate against your airline’s current offer.</span>
          </div>
          <div class="section-body">
            <ul class="options-list">
              ${items}
            </ul>
          </div>
        </section>
      `;
    }

    let messagesHtml = "";
    if (messages.length) {
      const blocks = messages
        .map((msg, index) => {
          const label = msg.label || `Message ${index + 1}`;
          const text = msg.text || "";
          const textareaId = `msg_${msg.id || index}`;
          return `
            <div class="section" data-message-id="${textareaId}">
              <div class="section-title">
                <span>${escapeHtml(label)}</span>
                <span class="sub">Copy & paste this text.</span>
              </div>
              <div class="section-body">
                <div class="message-block">
                  <textarea id="${textareaId}" readonly>${escapeHtml(
                    text
                  )}</textarea>
                  <button type="button" class="btn-secondary btn-copy" data-target="${textareaId}">
                    <span class="btn-icon">📋</span>
                    Copy
                  </button>
                </div>
              </div>
            </div>
          `;
        })
        .join("");
      messagesHtml = blocks;
    }

    let hotelsHtml = "";
    if (hotels.length) {
      const items = hotels
        .map((h) => {
          const name = h.name || "Hotel";
          const distance =
            typeof h.distanceKm === "number"
              ? `${h.distanceKm.toFixed(1)} km`
              : "";
          const rating =
            typeof h.rating === "number" ? `${h.rating.toFixed(1)}/10` : "";
          const address = h.address || "";
          const mapsLink = h.mapsUrl
            ? `<a href="${encodeURI(
                h.mapsUrl
              )}" target="_blank" rel="noopener noreferrer">View on map</a>`
            : "";

          return `
            <li>
              <strong>${escapeHtml(name)}</strong>
              <div class="pill-row" style="margin-top: 3px; margin-bottom: 3px;">
                ${
                  distance
                    ? `<span class="chip">~${escapeHtml(distance)} from airport</span>`
                    : ""
                }
                ${
                  rating
                    ? `<span class="chip">Rating ${escapeHtml(rating)}</span>`
                    : ""
                }
              </div>
              ${
                address
                  ? `<div style="font-size:0.78rem; margin-bottom: 2px;">${escapeHtml(
                      address
                    )}</div>`
                  : ""
              }
              ${mapsLink}
            </li>
          `;
        })
        .join("");

      hotelsHtml = `
        <section class="section">
          <div class="section-title">
            <span>Nearby hotel ideas</span>
            <span class="sub">Check live prices & availability on your favourite site.</span>
          </div>
          <div class="section-body">
            <ul class="hotel-list">
              ${items}
            </ul>
          </div>
        </section>
      `;
    }

    resultsEl.innerHTML = `
      ${statusHtml}
      ${explanationHtml}
      ${optionsHtml}
      ${messagesHtml}
      ${hotelsHtml}
    `;

    // Attach copy buttons
    resultsEl.querySelectorAll(".btn-copy").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.getAttribute("data-target");
        const textarea = document.getElementById(targetId);
        if (!textarea) return;
        textarea.select();
        textarea.setSelectionRange(0, 99999);
        try {
          document.execCommand("copy");
        } catch (e) {
          navigator.clipboard?.writeText(textarea.value).catch(() => {});
        }
        const original = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = original;
        }, 1300);
      });
    });
  }

  function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function nl2br(str) {
    return String(str).replace(/\n/g, "<br>");
  }
</script>
