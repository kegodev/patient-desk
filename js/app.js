(() => {
      "use strict";

      const SUPABASE_URL = window.PATIENT_DESK_CONFIG?.SUPABASE_URL || "";
      const SUPABASE_PUBLISHABLE_KEY = window.PATIENT_DESK_CONFIG?.SUPABASE_PUBLISHABLE_KEY || "";
      if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
        console.error("Patient Desk: configure js/config.js with your Supabase URL and publishable key.");
      }
      if (!window.supabase) {
        const message = document.getElementById("login-message");
        if (message) {
          message.textContent = "Supabase could not load. Check your internet connection, then reload the page.";
          message.classList.add("show", "error");
        }
        return;
      }

      const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });

      const todayISO = () => new Date().toISOString().slice(0, 10);
      let records = [];
      let activeClientId = null;
      let editingClientId = null;
      let currentUser = null;
      let currentPractice = null;
      let currentCryptoProfile = null;
      let dataEncryptionKey = null;
      let blindIndexKey = null;
      let cryptoSetupMode = "unlock";
      let toastTimer;
      let enterPromise = null;

      const CRYPTO_VERSION = 1;
      const PBKDF2_ITERATIONS = 600000;
      const CRYPTO_AAD_PREFIX = "patient-desk";

      const $ = (selector, root = document) => root.querySelector(selector);
      const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

      function bytesToBase64(bytes) {
        const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let binary = "";
        for (let i = 0; i < view.length; i += 0x8000) {
          binary += String.fromCharCode(...view.subarray(i, Math.min(i + 0x8000, view.length)));
        }
        return btoa(binary);
      }

      function base64ToBytes(value = "") {
        const binary = atob(String(value));
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      }

      function base64Url(bytes) {
        return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      }

      function randomBytes(length) {
        return crypto.getRandomValues(new Uint8Array(length));
      }

      function makeUUID() {
        if (crypto.randomUUID) return crypto.randomUUID();
        const bytes = randomBytes(16);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const h = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
      }

      async function deriveWrappingKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
        const material = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(passphrase),
          "PBKDF2",
          false,
          ["deriveKey"]
        );
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
      }

      async function deriveBlindIndexKey(rawDek) {
        const ikm = await crypto.subtle.importKey("raw", rawDek, "HKDF", false, ["deriveKey"]);
        const salt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`practice:${currentPractice.id}`));
        return crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt,
            info: new TextEncoder().encode("patient-desk:file-number-blind-index:v1")
          },
          ikm,
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign"]
        );
      }

      function dekWrapAAD() {
        return new TextEncoder().encode(`${CRYPTO_AAD_PREFIX}|practice|${currentPractice.id}|dek|v${CRYPTO_VERSION}`);
      }

      function recordAAD(entity, id) {
        return new TextEncoder().encode(`${CRYPTO_AAD_PREFIX}|practice|${currentPractice.id}|${entity}|${id}|v${CRYPTO_VERSION}`);
      }

      async function importUnlockedKeys(rawDek) {
        dataEncryptionKey = await crypto.subtle.importKey(
          "raw",
          rawDek,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
        blindIndexKey = await deriveBlindIndexKey(rawDek);
      }

      async function createPracticeCrypto(passphrase) {
        const salt = randomBytes(16);
        const wrapIv = randomBytes(12);
        const rawDek = randomBytes(32);
        const wrappingKey = await deriveWrappingKey(passphrase, salt);
        const wrapped = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: wrapIv, additionalData: dekWrapAAD(), tagLength: 128 },
          wrappingKey,
          rawDek
        );

        const row = {
          practice_id: currentPractice.id,
          crypto_version: CRYPTO_VERSION,
          kdf: "PBKDF2-SHA256",
          kdf_iterations: PBKDF2_ITERATIONS,
          kdf_salt: bytesToBase64(salt),
          wrap_alg: "AES-256-GCM",
          wrap_iv: bytesToBase64(wrapIv),
          wrapped_dek: bytesToBase64(wrapped)
        };
        const saved = await supabaseClient.from("practice_crypto").insert(row).select("*").single();
        if (saved.error) throw saved.error;
        currentCryptoProfile = saved.data;
        await importUnlockedKeys(rawDek);
      }

      async function unlockPracticeCrypto(passphrase) {
        if (!currentCryptoProfile) throw new Error("Encryption profile not found.");
        const salt = base64ToBytes(currentCryptoProfile.kdf_salt);
        const wrapIv = base64ToBytes(currentCryptoProfile.wrap_iv);
        const wrappingKey = await deriveWrappingKey(
          passphrase,
          salt,
          Number(currentCryptoProfile.kdf_iterations || PBKDF2_ITERATIONS)
        );
        let rawDek;
        try {
          rawDek = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: wrapIv, additionalData: dekWrapAAD(), tagLength: 128 },
            wrappingKey,
            base64ToBytes(currentCryptoProfile.wrapped_dek)
          );
        } catch {
          throw new Error("Incorrect encryption passphrase.");
        }
        await importUnlockedKeys(rawDek);
      }

      async function encryptPayload(entity, id, payload) {
        if (!dataEncryptionKey) throw new Error("Patient data is locked.");
        const iv = randomBytes(12);
        const encoded = new TextEncoder().encode(JSON.stringify(payload));
        const ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: recordAAD(entity, id), tagLength: 128 },
          dataEncryptionKey,
          encoded
        );
        return {
          v: CRYPTO_VERSION,
          alg: "A256GCM",
          iv: bytesToBase64(iv),
          ct: bytesToBase64(ciphertext)
        };
      }

      async function decryptPayload(entity, id, envelope) {
        if (!envelope) return null;
        if (!dataEncryptionKey) throw new Error("Patient data is locked.");
        const parsed = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
        if (Number(parsed.v) !== CRYPTO_VERSION || parsed.alg !== "A256GCM") {
          throw new Error("Unsupported encrypted record version.");
        }
        try {
          const plaintext = await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: base64ToBytes(parsed.iv),
              additionalData: recordAAD(entity, id),
              tagLength: 128
            },
            dataEncryptionKey,
            base64ToBytes(parsed.ct)
          );
          return JSON.parse(new TextDecoder().decode(plaintext));
        } catch {
          throw new Error("A protected patient record could not be decrypted. The data may be damaged or the wrong surgery key is unlocked.");
        }
      }

      async function blindIndex(value) {
        if (!blindIndexKey) throw new Error("Patient data is locked.");
        const normalized = String(value || "").trim().toLowerCase();
        if (!normalized) return null;
        const signature = await crypto.subtle.sign("HMAC", blindIndexKey, new TextEncoder().encode(normalized));
        return `v1:${base64Url(signature)}`;
      }

      function clearCryptoKeys() {
        dataEncryptionKey = null;
        blindIndexKey = null;
        currentCryptoProfile = null;
      }

      function setEncryptionStatus() {
        const status = $("#encryption-status");
        if (status) {
          status.textContent = dataEncryptionKey
            ? "Unlocked · AES-256-GCM client-side encryption active"
            : "Locked · encryption key removed from this browser session";
        }
      }

      function escapeHTML(value = "") {
        return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
      }

      function initials(name = "") {
        return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "AD";
      }

      function formatDate(value, short = false) {
        if (!value) return "No consultations";
        const date = new Date(value + "T12:00:00");
        return new Intl.DateTimeFormat("en-ZA", short ? { day: "2-digit", month: "short", year: "numeric" } : { day: "numeric", month: "long", year: "numeric" }).format(date);
      }

      function maskID(value) {
        if (!value) return "—";
        return "••••••" + String(value).slice(-4);
      }

      function latestConsultation(client) {
        return [...client.consultations].sort((a, b) => b.date.localeCompare(a.date))[0] || null;
      }

      function allConsultations() {
        return records.flatMap(client => client.consultations.map(visit => ({ ...visit, clientId: client.id, clientName: client.name, fileNumber: client.fileNumber }))).sort((a, b) => b.date.localeCompare(a.date));
      }

      function matches(client, term) {
        const text = [client.name, client.fileNumber, client.idNumber, client.medicalAid, client.medicalAidNumber, client.plan, ...client.beneficiaries.flatMap(b => [b.name, b.fileNumber])].join(" ").toLowerCase();
        return text.includes(term.trim().toLowerCase());
      }

      function sortClients(list, sort) {
        return [...list].sort((a, b) => {
          if (sort === "name") return a.name.localeCompare(b.name);
          if (sort === "file") return a.fileNumber.localeCompare(b.fileNumber);
          return (latestConsultation(b)?.date || "").localeCompare(latestConsultation(a)?.date || "");
        });
      }

      function clientTableHTML(list) {
        if (!list.length) {
          return `<div class="empty-state"><div class="empty-icon"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></div><h3>No matching clients</h3><p>Try a different name, patient or beneficiary file number, ID or medical aid.</p><button class="secondary-button small-button add-client-trigger">Add a new client</button></div>`;
        }
        return `<div class="table-shell"><table><thead><tr><th>Client name</th><th>Last consultation</th><th>File number</th><th>Medical aid</th><th>Beneficiaries</th><th aria-label="Actions"></th></tr></thead><tbody>${list.map(client => {
          const latest = latestConsultation(client);
          return `<tr data-client-id="${escapeHTML(client.id)}" tabindex="0"><td><div class="name-cell"><span class="initials">${initials(client.name)}</span><div><div class="client-name">${escapeHTML(client.name)}</div><div class="client-sub">ID ${escapeHTML(maskID(client.idNumber))}</div></div></div></td><td>${latest ? `<div class="date-main">${formatDate(latest.date, true)}</div><div class="date-sub">${latest.personType === "beneficiary" ? "Beneficiary · " + escapeHTML(latest.personName) : "Primary client"}</div>` : `<span class="status-badge none">Not yet consulted</span>`}</td><td><span class="file-number">${escapeHTML(client.fileNumber)}</span></td><td><span class="aid-badge">${escapeHTML(client.medicalAid)}</span></td><td><span class="beneficiary-count"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 8h4M19 6v4"/></svg>${client.beneficiaries.length}</span></td><td><button class="row-action" data-open-client="${escapeHTML(client.id)}" aria-label="View ${escapeHTML(client.name)}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 18 6-6-6-6"/></svg></button></td></tr>`;
        }).join("")}</tbody></table></div>`;
      }

      function renderHome() {
        const search = $("#home-search").value;
        const sort = $("#home-sort").value;
        const filtered = sortClients(records.filter(client => matches(client, search)), sort);
        $("#home-table").innerHTML = clientTableHTML(filtered);
        $("#result-count").textContent = search ? `${filtered.length} result${filtered.length === 1 ? "" : "s"} for “${search}”` : `${records.length} registered client${records.length === 1 ? "" : "s"}`;
        $("#clear-search").classList.toggle("visible", Boolean(search));
        bindClientRows($("#home-table"));
      }

      function renderClients() {
        const search = $("#clients-search").value;
        const filtered = sortClients(records.filter(client => matches(client, search)), "name");
        $("#clients-table").innerHTML = clientTableHTML(filtered);
        $("#clients-result-count").textContent = `${filtered.length} client file${filtered.length === 1 ? "" : "s"}`;
        bindClientRows($("#clients-table"));
      }

      function renderConsultations() {
        const filter = $("#consultation-filter").value;
        const visits = allConsultations().filter(visit => filter === "all" || visit.personType === filter);
        $("#consultation-count").textContent = `${visits.length} recorded visit${visits.length === 1 ? "" : "s"}`;
        if (!visits.length) {
          $("#consultations-table").innerHTML = `<div class="empty-state"><div class="empty-icon"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/></svg></div><h3>No consultations found</h3><p>Record a visit to begin the consultation history.</p></div>`;
          return;
        }
        $("#consultations-table").innerHTML = `<div class="table-shell"><table><thead><tr><th>Date</th><th>Person consulted</th><th>Client file</th><th>Visit type</th><th>Notes</th></tr></thead><tbody>${visits.map(visit => `<tr data-client-id="${escapeHTML(visit.clientId)}" tabindex="0"><td><span class="date-main">${formatDate(visit.date, true)}</span></td><td><div class="client-name">${escapeHTML(visit.personName)}</div><div class="client-sub">${visit.personType === "beneficiary" ? "Beneficiary" : "Primary client"}</div></td><td><span class="file-number">${escapeHTML(visit.fileNumber)}</span><div class="client-sub">${escapeHTML(visit.clientName)}</div></td><td><span class="status-badge">${escapeHTML(visit.type)}</span></td><td><span class="date-sub">${escapeHTML(visit.notes || "—")}</span></td></tr>`).join("")}</tbody></table></div>`;
        bindClientRows($("#consultations-table"));
      }

      function renderStats() {
        const visits = allConsultations();
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        $("#stat-clients").textContent = records.length;
        $("#stat-beneficiaries").textContent = records.reduce((sum, client) => sum + client.beneficiaries.length, 0);
        $("#stat-consultations").textContent = visits.filter(visit => visit.date.startsWith(monthKey)).length;
        $("#stat-today").textContent = visits.filter(visit => visit.date === todayISO()).length;
      }

      function renderAll() {
        renderStats();
        renderHome();
        renderClients();
        renderConsultations();
        populateClientSelect();
        if (activeClientId && records.some(client => client.id === activeClientId) && $("#client-drawer").classList.contains("open")) renderDrawer(activeClientId);
      }

      function bindClientRows(container) {
        $$('[data-client-id]', container).forEach(row => {
          row.addEventListener("click", event => {
            if (event.target.closest("button")) return;
            openClient(row.dataset.clientId);
          });
          row.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openClient(row.dataset.clientId); }
          });
        });
        $$('[data-open-client]', container).forEach(button => button.addEventListener("click", () => openClient(button.dataset.openClient)));
        $$('.add-client-trigger', container).forEach(button => button.addEventListener("click", () => openClientModal()));
      }

      function closeHeaderMenu() {
        $("#header-menu").classList.remove("open");
        $("#menu-toggle").setAttribute("aria-expanded", "false");
        $("#menu-toggle").setAttribute("aria-label", "Open navigation menu");
        document.body.classList.remove("menu-open");
      }

      function showLegalView(name) {
        closeHeaderMenu();
        $$('.legal-page').forEach(page => page.hidden = page.id !== `legal-${name}`);
        document.body.classList.add('legal-open');
        const page = $(`#legal-${name}`);
        if (page) page.scrollTop = 0;
      }

      function closeLegalView() {
        $$('.legal-page').forEach(page => page.hidden = true);
        document.body.classList.remove('legal-open');
      }

      function showView(name) {
        if (!currentUser || !currentPractice) { showAuthView("login"); return; }
        $$('.view').forEach(view => view.hidden = view.id !== `view-${name}`);
        $$('.nav-item[data-view]').forEach(item => item.classList.toggle("active", item.dataset.view === name));
        $("#crumb-current").textContent = ({ home: "Overview", clients: "Clients", consultations: "Visits", settings: "Settings" })[name];
        closeHeaderMenu();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }

      function showAuthView(name) {
        if (name !== "database") document.body.classList.remove("auth-database-needed");
        document.body.classList.add("auth-signed-out");
        if (currentUser && name === "database") document.body.classList.remove("auth-signed-out");
        $$('.auth-panel').forEach(panel => panel.hidden = panel.id !== `auth-${name}`);
        $("#crumb-current").textContent = ({ login: "Login", crypto: "Encrypted data", database: "Database setup" })[name] || "Login";
        closeHeaderMenu();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }

      function openLayer(element) {
        closeLayers();
        $("#overlay").classList.add("open");
        element.classList.add("open");
        document.body.style.overflow = "hidden";
      }

      function closeLayers() {
        $$('.modal, .drawer').forEach(layer => layer.classList.remove("open"));
        $("#overlay").classList.remove("open");
        document.body.style.overflow = "";
      }

      function openClientModal(clientId = null) {
        if (!currentUser) { showAuthView("login"); return; }
        const client = clientId ? records.find(item => item.id === clientId) : null;
        editingClientId = client ? client.id : null;
        $("#client-form").reset();
        $("#beneficiary-form-list").innerHTML = "";

        if (client) {
          $("#client-modal-title").textContent = "Edit patient information";
          $("#client-modal-title").nextElementSibling.textContent = "Update the patient file and linked beneficiaries.";
          $("#client-name").value = client.name || "";
          $("#client-id").value = client.idNumber || "";
          $("#client-file").value = client.fileNumber || "";
          $("#client-aid").value = client.medicalAid || "";
          $("#client-aid-number").value = client.medicalAidNumber || "";
          $("#client-plan").value = client.plan || "";
          client.beneficiaries.forEach(person => addBeneficiaryRow(person.name, person.relationship, person.id, person.fileNumber));
          $("#client-form button[type=\"submit\"]").textContent = "Save changes";
        } else {
          $("#client-modal-title").textContent = "Add a new client";
          $("#client-modal-title").nextElementSibling.textContent = "Create a primary member file and link beneficiaries.";
          $("#client-form button[type=\"submit\"]").textContent = "Save client";
        }

        openLayer($("#client-modal"));
        setTimeout(() => $("#client-name").focus(), 40);
      }

      function addBeneficiaryRow(name = "", relationship = "Child", beneficiaryId = "", fileNumber = "") {
        const row = document.createElement("div");
        row.className = "beneficiary-form-row";
        if (beneficiaryId) row.dataset.beneficiaryId = beneficiaryId;
        row.innerHTML = `<input class="beneficiary-name-input" aria-label="Beneficiary name" placeholder="Full name" value="${escapeHTML(name)}"><input class="beneficiary-file-input" aria-label="Beneficiary file number" placeholder="File number" value="${escapeHTML(fileNumber)}"><select class="beneficiary-relation-input" aria-label="Relationship"><option${relationship === "Spouse" ? " selected" : ""}>Spouse</option><option${relationship === "Child" ? " selected" : ""}>Child</option><option${relationship === "Parent" ? " selected" : ""}>Parent</option><option${relationship === "Other" ? " selected" : ""}>Other</option></select><button type="button" class="remove-beneficiary" aria-label="Remove beneficiary"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5"/></svg></button>`;
        $(".remove-beneficiary", row).addEventListener("click", () => row.remove());
        $("#beneficiary-form-list").appendChild(row);
        $(".beneficiary-name-input", row).focus();
      }

      function openClient(clientId) {
        activeClientId = clientId;
        renderDrawer(clientId);
        openLayer($("#client-drawer"));
      }

      function renderDrawer(clientId) {
        const client = records.find(item => item.id === clientId);
        if (!client) return;
        $("#drawer-initials").textContent = initials(client.name);
        $("#drawer-client-name").textContent = client.name;
        $("#drawer-file-number").textContent = `File ${client.fileNumber}`;
        const visits = [...client.consultations].sort((a, b) => b.date.localeCompare(a.date));
        $("#drawer-content").innerHTML = `
          <div class="detail-actions">
            <button class="primary-button" id="drawer-record-visit"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>Record visit</button>
            <button class="ghost-button" id="drawer-edit-client"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>Edit patient</button>
            <button class="ghost-button" id="copy-file-number"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>Copy file no.</button>
          </div>
          <section class="detail-section">
            <div class="detail-section-head"><h3>Client information</h3><span class="aid-badge">Active file</span></div>
            <div class="detail-meta-grid">
              <div class="detail-meta"><span>File number</span><strong>${escapeHTML(client.fileNumber)}</strong></div>
              <div class="detail-meta"><span>ID number</span><strong>${escapeHTML(maskID(client.idNumber))}</strong></div>
              <div class="detail-meta"><span>Medical aid</span><strong>${escapeHTML(client.medicalAid)}</strong></div>
              <div class="detail-meta"><span>Medical aid number</span><strong>${escapeHTML(client.medicalAidNumber || "Not provided")}</strong></div>
              <div class="detail-meta"><span>Plan / option</span><strong>${escapeHTML(client.plan || "Not provided")}</strong></div>
            </div>
          </section>
          <section class="detail-section">
            <div class="detail-section-head"><h3>Beneficiaries (${client.beneficiaries.length})</h3></div>
            ${client.beneficiaries.length ? `<div class="beneficiary-list">${client.beneficiaries.map(person => `<div class="beneficiary-item"><div class="beneficiary-person"><span class="mini-avatar">${initials(person.name)}</span><div><strong>${escapeHTML(person.name)}</strong><small>${escapeHTML(person.relationship)}${person.fileNumber ? ` · File ${escapeHTML(person.fileNumber)}` : ""}</small></div></div><button class="tiny-action" data-record-beneficiary="${escapeHTML(person.id)}">Record visit</button></div>`).join("")}</div>` : `<div class="no-records">No beneficiaries linked to this file.</div>`}
          </section>
          <section class="detail-section">
            <div class="detail-section-head"><h3>Consultation history</h3><span class="aid-badge">${visits.length} visit${visits.length === 1 ? "" : "s"}</span></div>
            ${visits.length ? `<div class="timeline">${visits.map(visit => `<div class="timeline-item"><span class="timeline-dot"></span><div class="timeline-copy"><div class="timeline-date">${formatDate(visit.date)} · ${escapeHTML(visit.type)}</div><div class="timeline-person">${visit.personType === "beneficiary" ? "Beneficiary" : "Primary client"} — ${escapeHTML(visit.personName)}</div>${visit.notes ? `<div class="timeline-note">${escapeHTML(visit.notes)}</div>` : ""}</div></div>`).join("")}</div>` : `<div class="no-records">No consultations recorded yet.</div>`}
          </section>`;
        $("#drawer-record-visit").addEventListener("click", () => openConsultationModal(client.id));
        $("#drawer-edit-client").addEventListener("click", () => openClientModal(client.id));
        $("#copy-file-number").addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(client.fileNumber); showToast("File number copied"); }
          catch (_) { showToast(`File number: ${client.fileNumber}`); }
        });
        $$('[data-record-beneficiary]').forEach(button => button.addEventListener("click", () => openConsultationModal(client.id, `beneficiary:${button.dataset.recordBeneficiary}`)));
      }

      function populateClientSelect(selectedId) {
        const select = $("#consult-client");
        const prior = selectedId || select.value;
        select.innerHTML = `<option value="">Select a client file</option>` + sortClients(records, "name").map(client => `<option value="${escapeHTML(client.id)}">${escapeHTML(client.name)} · ${escapeHTML(client.fileNumber)}</option>`).join("");
        if (records.some(client => client.id === prior)) select.value = prior;
        populatePersonSelect();
      }

      function populatePersonSelect(selectedKey) {
        const client = records.find(item => item.id === $("#consult-client").value);
        const select = $("#consult-person");
        if (!client) { select.innerHTML = `<option value="">Select a client file first</option>`; return; }
        select.innerHTML = `<option value="client:${escapeHTML(client.id)}">${escapeHTML(client.name)} — Primary client</option>` + client.beneficiaries.map(person => `<option value="beneficiary:${escapeHTML(person.id)}">${escapeHTML(person.name)} — ${escapeHTML(person.relationship)}</option>`).join("");
        if (selectedKey) select.value = selectedKey;
      }

      function openConsultationModal(clientId, personKey) {
        if (!currentUser) { showAuthView("login"); return; }
        $("#consultation-form").reset();
        populateClientSelect(clientId);
        if (clientId) $("#consult-client").value = clientId;
        populatePersonSelect(personKey);
        $("#consult-date").value = todayISO();
        openLayer($("#consultation-modal"));
        setTimeout(() => $("#consult-client").focus(), 40);
      }

      function showToast(message) {
        clearTimeout(toastTimer);
        $("#toast-message").textContent = message;
        $("#toast").classList.add("show");
        toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 3000);
      }

      function showAuthMessage(id, message, isError = false) {
        const el = $(id);
        el.textContent = message;
        el.classList.add("show");
        el.classList.toggle("error", isError);
      }

      function clearAuthMessage(id) {
        const el = $(id);
        el.textContent = "";
        el.classList.remove("show", "error");
      }

      function setButtonBusy(button, busy, busyText, normalText) {
        button.disabled = busy;
        button.textContent = busy ? busyText : normalText;
      }

      function setDatabaseStatus(text) {
        if ($("#supabase-status")) $("#supabase-status").textContent = text;
      }

      function initializeDate() {
        const label = new Intl.DateTimeFormat("en-ZA", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
        $("#today-label").textContent = label;
      }

      function databaseSetupError(error) {
        const message = String(error?.message || "").toLowerCase();
        return error?.code === "42P01" || error?.code === "42703" || error?.code === "PGRST204" || error?.code === "PGRST205" || message.includes("could not find the table") || message.includes("could not find the") && message.includes("column") || message.includes("relation") && message.includes("does not exist");
      }

      async function ensurePracticeSetup(user) {
        const membershipResult = await supabaseClient
          .from("practice_members")
          .select("practice_id, role")
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();
        if (membershipResult.error) throw membershipResult.error;

        if (membershipResult.data?.practice_id) {
          const practiceResult = await supabaseClient.from("practices").select("id, name, owner_id").eq("id", membershipResult.data.practice_id).single();
          if (practiceResult.error) throw practiceResult.error;
          return practiceResult.data;
        }

        const ownedResult = await supabaseClient.from("practices").select("id, name, owner_id").eq("owner_id", user.id).limit(1).maybeSingle();
        if (ownedResult.error) throw ownedResult.error;
        let practice = ownedResult.data;

        if (!practice) {
          const practiceName = String(user.user_metadata?.practice_name || "").trim();
          if (!practiceName) throw new Error("This account has no surgery workspace. Please create the account from Set up.");
          const createPractice = await supabaseClient.from("practices").insert({ name: practiceName, owner_id: user.id }).select("id, name, owner_id").single();
          if (createPractice.error) throw createPractice.error;
          practice = createPractice.data;
        }

        const addMember = await supabaseClient.from("practice_members").insert({ practice_id: practice.id, user_id: user.id, role: "owner" });
        if (addMember.error && addMember.error.code !== "23505") throw addMember.error;
        return practice;
      }

      async function loadCryptoProfile() {
        const result = await supabaseClient
          .from("practice_crypto")
          .select("practice_id, crypto_version, kdf, kdf_iterations, kdf_salt, wrap_alg, wrap_iv, wrapped_dek, created_at, updated_at")
          .eq("practice_id", currentPractice.id)
          .maybeSingle();
        if (result.error) throw result.error;
        currentCryptoProfile = result.data || null;
        return currentCryptoProfile;
      }

      async function fetchRawWorkspace() {
        const [patientsResult, beneficiariesResult, consultationsResult] = await Promise.all([
          supabaseClient.from("patients").select("id, practice_id, name, id_number, file_number, medical_aid, medical_aid_number, plan, encrypted_payload, file_number_bidx, created_at, updated_at").eq("practice_id", currentPractice.id),
          supabaseClient.from("beneficiaries").select("id, practice_id, patient_id, name, relationship, file_number, encrypted_payload, file_number_bidx, created_at").eq("practice_id", currentPractice.id),
          supabaseClient.from("consultations").select("id, practice_id, patient_id, beneficiary_id, person_type, person_name, visit_date, visit_type, notes, encrypted_payload, created_at").eq("practice_id", currentPractice.id)
        ]);
        if (patientsResult.error) throw patientsResult.error;
        if (beneficiariesResult.error) throw beneficiariesResult.error;
        if (consultationsResult.error) throw consultationsResult.error;
        return {
          patients: patientsResult.data || [],
          beneficiaries: beneficiariesResult.data || [],
          consultations: consultationsResult.data || []
        };
      }

      async function migrateLegacyRows() {
        if (!dataEncryptionKey) return;
        setDatabaseStatus(`Securing ${currentPractice.name}…`);
        const raw = await fetchRawWorkspace();

        for (const row of raw.patients) {
          if (row.encrypted_payload) continue;
          const payload = {
            name: row.name || "",
            idNumber: row.id_number || "",
            fileNumber: row.file_number || "",
            medicalAid: row.medical_aid || "",
            medicalAidNumber: row.medical_aid_number || "",
            plan: row.plan || ""
          };
          const envelope = await encryptPayload("patient", row.id, payload);
          const fileBidx = await blindIndex(payload.fileNumber);
          const update = await supabaseClient.from("patients").update({
            encrypted_payload: envelope,
            file_number_bidx: fileBidx,
            name: "",
            id_number: "",
            file_number: "",
            medical_aid: "",
            medical_aid_number: "",
            plan: "",
            updated_at: new Date().toISOString()
          }).eq("id", row.id).eq("practice_id", currentPractice.id);
          if (update.error) throw update.error;
        }

        for (const row of raw.beneficiaries) {
          if (row.encrypted_payload) continue;
          const payload = {
            name: row.name || "",
            relationship: row.relationship || "Other",
            fileNumber: row.file_number || ""
          };
          const envelope = await encryptPayload("beneficiary", row.id, payload);
          const update = await supabaseClient.from("beneficiaries").update({
            encrypted_payload: envelope,
            file_number_bidx: await blindIndex(payload.fileNumber),
            name: "",
            relationship: "",
            file_number: ""
          }).eq("id", row.id).eq("practice_id", currentPractice.id);
          if (update.error) throw update.error;
        }

        for (const row of raw.consultations) {
          if (row.encrypted_payload) continue;
          const payload = {
            date: row.visit_date || "",
            personName: row.person_name || "",
            type: row.visit_type || "General consultation",
            notes: row.notes || ""
          };
          const envelope = await encryptPayload("consultation", row.id, payload);
          const update = await supabaseClient.from("consultations").update({
            encrypted_payload: envelope,
            person_name: null,
            visit_date: null,
            visit_type: null,
            notes: null
          }).eq("id", row.id).eq("practice_id", currentPractice.id);
          if (update.error) throw update.error;
        }
      }

      async function loadRecordsFromSupabase() {
        if (!currentPractice) { records = []; return; }
        if (!dataEncryptionKey) throw new Error("Patient data is locked.");
        setDatabaseStatus(`Decrypting ${currentPractice.name} locally…`);

        const result = await supabaseClient
          .from("patients")
          .select(`
            id, encrypted_payload, created_at,
            beneficiaries ( id, encrypted_payload ),
            consultations ( id, person_type, beneficiary_id, encrypted_payload )
          `)
          .eq("practice_id", currentPractice.id)
          .order("created_at", { ascending: false });
        if (result.error) throw result.error;

        const decoded = [];
        for (const row of (result.data || [])) {
          const patient = await decryptPayload("patient", row.id, row.encrypted_payload);
          if (!patient) continue;
          const beneficiaries = [];
          for (const person of (row.beneficiaries || [])) {
            const payload = await decryptPayload("beneficiary", person.id, person.encrypted_payload);
            if (!payload) continue;
            beneficiaries.push({
              id: person.id,
              name: payload.name || "",
              relationship: payload.relationship || "Other",
              fileNumber: payload.fileNumber || ""
            });
          }
          const consultations = [];
          for (const visit of (row.consultations || [])) {
            const payload = await decryptPayload("consultation", visit.id, visit.encrypted_payload);
            if (!payload) continue;
            consultations.push({
              id: visit.id,
              date: payload.date || "",
              personType: visit.person_type,
              personId: visit.person_type === "client" ? row.id : (visit.beneficiary_id || ""),
              personName: payload.personName || "",
              type: payload.type || "General consultation",
              notes: payload.notes || ""
            });
          }
          decoded.push({
            id: row.id,
            name: patient.name || "",
            idNumber: patient.idNumber || "",
            fileNumber: patient.fileNumber || "",
            medicalAid: patient.medicalAid || "",
            medicalAidNumber: patient.medicalAidNumber || "",
            plan: patient.plan || "",
            createdAt: row.created_at || "",
            beneficiaries: beneficiaries.sort((a, b) => a.name.localeCompare(b.name)),
            consultations
          });
        }
        records = decoded;
        setDatabaseStatus(`Connected to ${currentPractice.name} · encrypted at rest · ${records.length} patient record${records.length === 1 ? "" : "s"}`);
        setEncryptionStatus();
      }

      function updateIdentityUI() {
        const fullName = String(currentUser?.user_metadata?.full_name || currentUser?.email?.split("@")[0] || "Administrator");
        $("#sidebar-user-name").textContent = fullName;
        $("#sidebar-practice-name").textContent = currentPractice?.name || "Admin Control";
        $("#dashboard-practice-name").textContent = currentPractice?.name || "Your surgery";
        $(".avatar").textContent = initials(fullName);
        $("#menu-account-email").textContent = currentUser?.email || "—";
      }

      function configureCryptoPanel(mode) {
        cryptoSetupMode = mode;
        clearAuthMessage("#crypto-message");
        $("#crypto-form").reset();
        const creating = mode === "setup";
        $("#crypto-title").textContent = creating ? "Protect this surgery" : "Unlock surgery data";
        $("#crypto-copy").textContent = creating
          ? "Create a separate encryption passphrase. Patient content will be encrypted before it is sent to Supabase."
          : `Enter ${currentPractice?.name || "this surgery"}'s encryption passphrase. Decryption happens only on this device.`;
        $("#crypto-confirm-field").hidden = !creating;
        $("#crypto-confirm").required = creating;
        $("#crypto-submit").textContent = creating ? "Enable encryption" : "Unlock patient data";
        $("#crypto-meta").textContent = creating
          ? "Important: KM Digital Labs and Supabase cannot recover this passphrase. Store it securely outside the app."
          : "AES-256-GCM encryption. The passphrase and unwrapped encryption key are kept only in browser memory.";
        showAuthView("crypto");
        setTimeout(() => $("#crypto-passphrase").focus(), 40);
      }

      async function finishEnterApp() {
        await migrateLegacyRows();
        await loadRecordsFromSupabase();
        document.body.classList.remove("auth-database-needed", "auth-signed-out");
        document.body.classList.add("auth-signed-in");
        updateIdentityUI();
        setEncryptionStatus();
        renderAll();
        showView("home");
      }

      async function enterApp(user, force = false) {
        if (enterPromise) return enterPromise;
        if (!force && currentUser?.id === user.id && currentPractice && dataEncryptionKey) return;
        enterPromise = (async () => {
          try {
            currentUser = user;
            currentPractice = await ensurePracticeSetup(user);
            updateIdentityUI();
            await loadCryptoProfile();
            document.body.classList.remove("auth-database-needed", "auth-signed-in");
            if (!dataEncryptionKey) {
              configureCryptoPanel(currentCryptoProfile ? "unlock" : "setup");
              return;
            }
            await finishEnterApp();
          } catch (error) {
            console.error(error);
            records = [];
            if (databaseSetupError(error)) {
              currentPractice = currentPractice || null;
              document.body.classList.remove("auth-signed-out");
              document.body.classList.add("auth-signed-in", "auth-database-needed");
              $$('.auth-panel').forEach(panel => panel.hidden = panel.id !== "auth-database");
              $("#crumb-current").textContent = "Database setup";
              $("#database-message").innerHTML = 'Run <strong>sql/00_full_recovery.sql</strong> for a fresh Supabase project, or <strong>sql/02_e2ee_migration.sql</strong> if the base schema already exists, then retry.';
              setDatabaseStatus("Encrypted database migration required");
              closeHeaderMenu();
            } else {
              currentPractice = null;
              clearCryptoKeys();
              document.body.classList.remove("auth-signed-in");
              document.body.classList.add("auth-signed-out");
              showAuthView("login");
              showAuthMessage("#login-message", error.message || "Could not open the surgery workspace.", true);
            }
          } finally {
            enterPromise = null;
          }
        })();
        return enterPromise;
      }

      function lockPatientData(showUnlock = true) {
        records = [];
        activeClientId = null;
        editingClientId = null;
        dataEncryptionKey = null;
        blindIndexKey = null;
        closeLayers();
        renderAll();
        setEncryptionStatus();
        document.body.classList.remove("auth-signed-in");
        document.body.classList.add("auth-signed-out");
        if (showUnlock && currentUser && currentPractice) configureCryptoPanel("unlock");
      }

      function lockApp() {
        currentUser = null;
        currentPractice = null;
        records = [];
        activeClientId = null;
        editingClientId = null;
        clearCryptoKeys();
        closeLayers();
        document.body.classList.remove("auth-signed-in", "auth-database-needed");
        document.body.classList.add("auth-signed-out");
        renderAll();
        setEncryptionStatus();
        showAuthView("login");
      }

      async function refreshWorkspace(openClientId = null) {
        await loadRecordsFromSupabase();
        renderAll();
        if (openClientId && records.some(client => client.id === openClientId)) setTimeout(() => openClient(openClientId), 120);
      }

      async function createPatient(patientData, beneficiaries) {
        const patientId = makeUUID();
        const encryptedPatient = await encryptPayload("patient", patientId, patientData);
        const created = await supabaseClient.from("patients").insert({
          id: patientId,
          practice_id: currentPractice.id,
          name: "",
          id_number: "",
          file_number: "",
          medical_aid: "",
          medical_aid_number: "",
          plan: "",
          file_number_bidx: await blindIndex(patientData.fileNumber),
          encrypted_payload: encryptedPatient
        }).select("id").single();
        if (created.error) throw created.error;

        for (const person of beneficiaries) {
          const beneficiaryId = makeUUID();
          const envelope = await encryptPayload("beneficiary", beneficiaryId, {
            name: person.name,
            relationship: person.relationship,
            fileNumber: person.fileNumber
          });
          const inserted = await supabaseClient.from("beneficiaries").insert({
            id: beneficiaryId,
            practice_id: currentPractice.id,
            patient_id: patientId,
            name: "",
            relationship: "",
            file_number: "",
            file_number_bidx: await blindIndex(person.fileNumber),
            encrypted_payload: envelope
          });
          if (inserted.error) throw inserted.error;
        }
        return patientId;
      }

      async function updateConsultationPersonNames(client, patientName, beneficiaries) {
        const beneficiaryNames = new Map(beneficiaries.filter(p => p.id).map(p => [p.id, p.name]));
        for (const visit of client.consultations) {
          const newName = visit.personType === "client" ? patientName : beneficiaryNames.get(visit.personId);
          if (!newName || newName === visit.personName) continue;
          const envelope = await encryptPayload("consultation", visit.id, {
            date: visit.date,
            personName: newName,
            type: visit.type,
            notes: visit.notes || ""
          });
          const changed = await supabaseClient.from("consultations").update({
            encrypted_payload: envelope
          }).eq("id", visit.id).eq("patient_id", client.id).eq("practice_id", currentPractice.id);
          if (changed.error) throw changed.error;
        }
      }

      async function updatePatient(client, patientData, beneficiaries) {
        const encryptedPatient = await encryptPayload("patient", client.id, patientData);
        const updated = await supabaseClient.from("patients").update({
          encrypted_payload: encryptedPatient,
          file_number_bidx: await blindIndex(patientData.fileNumber),
          name: "",
          id_number: "",
          file_number: "",
          medical_aid: "",
          medical_aid_number: "",
          plan: "",
          updated_at: new Date().toISOString()
        }).eq("id", client.id).eq("practice_id", currentPractice.id);
        if (updated.error) throw updated.error;

        const existingIds = new Set(client.beneficiaries.map(person => person.id));
        const keptIds = new Set(beneficiaries.filter(person => person.id).map(person => person.id));
        const removedIds = [...existingIds].filter(id => !keptIds.has(id));
        if (removedIds.length) {
          const deleted = await supabaseClient.from("beneficiaries").delete().eq("practice_id", currentPractice.id).in("id", removedIds);
          if (deleted.error) throw deleted.error;
        }

        for (const person of beneficiaries) {
          if (person.id) {
            const envelope = await encryptPayload("beneficiary", person.id, {
              name: person.name,
              relationship: person.relationship,
              fileNumber: person.fileNumber
            });
            const changed = await supabaseClient.from("beneficiaries").update({
              encrypted_payload: envelope,
              file_number_bidx: await blindIndex(person.fileNumber),
              name: "",
              relationship: "",
              file_number: ""
            }).eq("id", person.id).eq("patient_id", client.id).eq("practice_id", currentPractice.id);
            if (changed.error) throw changed.error;
          } else {
            const beneficiaryId = makeUUID();
            const envelope = await encryptPayload("beneficiary", beneficiaryId, {
              name: person.name,
              relationship: person.relationship,
              fileNumber: person.fileNumber
            });
            const added = await supabaseClient.from("beneficiaries").insert({
              id: beneficiaryId,
              practice_id: currentPractice.id,
              patient_id: client.id,
              name: "",
              relationship: "",
              file_number: "",
              file_number_bidx: await blindIndex(person.fileNumber),
              encrypted_payload: envelope
            });
            if (added.error) throw added.error;
          }
        }

        await updateConsultationPersonNames(client, patientData.name, beneficiaries);
      }

      function selectedPdfMedicalAids() {
        return $$('#pdf-medical-aid-list input[type="checkbox"]:checked').map(input => input.value);
      }

      function updatePdfAidHint() {
        const total = $$('#pdf-medical-aid-list input[type="checkbox"]').length;
        const selected = selectedPdfMedicalAids().length;
        const hint = $('#pdf-aid-selection-hint');
        if (!total) hint.textContent = 'No medical aids are available yet.';
        else if (selected === total) hint.textContent = 'All medical aids are selected.';
        else if (selected === 0) hint.textContent = 'No medical aids selected.';
        else hint.textContent = `${selected} of ${total} medical aids selected.`;
        updatePdfExportSummary();
      }

      function populatePdfMedicalAidOptions() {
        const aids = [...new Set(records.map(client => String(client.medicalAid || '').trim()).filter(Boolean))]
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        const container = $('#pdf-medical-aid-list');
        if (!aids.length) {
          container.innerHTML = '<div class="pdf-filter-empty">No medical aids found in this surgery.</div>';
          updatePdfAidHint();
          return;
        }
        container.innerHTML = aids.map((aid, index) => `<label class="pdf-filter-option" for="pdf-aid-${index}"><input id="pdf-aid-${index}" type="checkbox" value="${escapeHTML(aid)}" checked><span>${escapeHTML(aid)}</span></label>`).join('');
        $$('input[type="checkbox"]', container).forEach(input => input.addEventListener('change', updatePdfAidHint));
        updatePdfAidHint();
      }

      function pdfDateInRange(dateValue, from, to) {
        if (!dateValue) return false;
        const date = String(dateValue).slice(0, 10);
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      }

      function getPdfFilteredPatients() {
        const selectedAids = new Set(selectedPdfMedicalAids());
        const totalAidOptions = $$('#pdf-medical-aid-list input[type="checkbox"]').length;
        const from = $('#pdf-date-from').value;
        const to = $('#pdf-date-to').value;
        const mode = $('#pdf-date-mode').value;

        return records.filter(client => {
          if (totalAidOptions && !selectedAids.has(client.medicalAid)) return false;
          if (!from && !to) return true;
          if (mode === 'consultation') return client.consultations.some(visit => pdfDateInRange(visit.date, from, to));
          return pdfDateInRange(client.createdAt, from, to);
        }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      }

      function updatePdfExportSummary() {
        const summary = $('#pdf-export-summary');
        if (!summary) return;
        const from = $('#pdf-date-from')?.value || '';
        const to = $('#pdf-date-to')?.value || '';
        const mode = $('#pdf-date-mode')?.value || 'created';
        const totalAidOptions = $$('#pdf-medical-aid-list input[type="checkbox"]').length;
        const selected = selectedPdfMedicalAids().length;
        const count = getPdfFilteredPatients().length;
        let dateText = 'all dates';
        if (from && to) dateText = `${formatDate(from, true)} to ${formatDate(to, true)}`;
        else if (from) dateText = `from ${formatDate(from, true)}`;
        else if (to) dateText = `up to ${formatDate(to, true)}`;
        const aidText = totalAidOptions && selected !== totalAidOptions ? `${selected} selected medical aid${selected === 1 ? '' : 's'}` : 'all medical aids';
        const dateModeText = mode === 'consultation' ? 'consultation date' : 'patient date added';
        summary.textContent = `${count} patient${count === 1 ? '' : 's'} will be exported · ${aidText} · ${dateText} by ${dateModeText} · sorted A–Z.`;
      }

      function openPdfExportModal() {
        if (!currentUser || !currentPractice) { showAuthView('login'); return; }
        $('#pdf-export-form').reset();
        populatePdfMedicalAidOptions();
        openLayer($('#pdf-export-modal'));
        updatePdfExportSummary();
      }

      function safePdfFilePart(value) {
        return String(value || 'surgery').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'surgery';
      }

      function downloadPatientRegisterPdf() {
        if (!currentPractice) return;
        const from = $('#pdf-date-from').value;
        const to = $('#pdf-date-to').value;
        if (from && to && from > to) {
          showToast('The From date cannot be after the To date');
          return;
        }

        const totalAidOptions = $$('#pdf-medical-aid-list input[type="checkbox"]').length;
        const selectedAids = selectedPdfMedicalAids();
        if (totalAidOptions && selectedAids.length === 0) {
          showToast('Select at least one medical aid');
          return;
        }

        const patients = getPdfFilteredPatients();
        if (!patients.length) {
          showToast('No patients match those PDF filters');
          return;
        }

        if (!window.jspdf?.jsPDF) {
          showToast('PDF tools could not load. Check your internet connection and try again.');
          return;
        }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        if (typeof doc.autoTable !== 'function') {
          showToast('PDF table tools could not load. Reload the page and try again.');
          return;
        }

        const selectedAidText = selectedAids.length === totalAidOptions ? 'All medical aids' : selectedAids.join(', ');
        const mode = $('#pdf-date-mode').value;
        let dateText = 'All dates';
        if (from && to) dateText = `${formatDate(from, true)} - ${formatDate(to, true)}`;
        else if (from) dateText = `From ${formatDate(from, true)}`;
        else if (to) dateText = `Up to ${formatDate(to, true)}`;
        const dateModeText = mode === 'consultation' ? 'Consultation date' : 'Patient date added';

        doc.setProperties({
          title: `${currentPractice.name} Patient Register`,
          subject: 'Patient names and file numbers',
          author: 'Admin Control - KM Digital Labs',
          creator: 'Admin Control'
        });
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(17);
        doc.text(String(currentPractice.name), 14, 17);
        doc.setFontSize(12);
        doc.text('Patient Register', 14, 24);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.text(`Generated: ${formatDate(todayISO(), true)}`, 14, 31);
        doc.text(`Medical aid filter: ${selectedAidText}`, 14, 36, { maxWidth: 182 });
        doc.text(`${dateModeText}: ${dateText}`, 14, 41);
        doc.text(`Total patients: ${patients.length}`, 14, 46);

        doc.autoTable({
          startY: 52,
          head: [['Patient name', 'File number']],
          body: patients.map(client => [client.name, client.fileNumber]),
          theme: 'grid',
          margin: { left: 14, right: 14, bottom: 14 },
          styles: { font: 'helvetica', fontSize: 9, cellPadding: 2.6, overflow: 'linebreak' },
          headStyles: { fontStyle: 'bold' },
          columnStyles: { 0: { cellWidth: 125 }, 1: { cellWidth: 48 } }
        });

        const pageCount = doc.getNumberOfPages();
        for (let page = 1; page <= pageCount; page += 1) {
          doc.setPage(page);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.5);
          doc.text(`Page ${page} of ${pageCount}`, 196, 289, { align: 'right' });
          doc.text('Admin Control · Designed by KM Digital Labs', 14, 289);
        }

        const fileName = `${safePdfFilePart(currentPractice.name)}-patient-register-${todayISO()}.pdf`;
        doc.save(fileName);
        closeLayers();
        showToast(`PDF downloaded · ${patients.length} patient${patients.length === 1 ? '' : 's'}`);
      }

      // Navigation and menu
      $$('.nav-item[data-view]').forEach(item => item.addEventListener("click", () => showView(item.dataset.view)));
      $$('[data-auth-view]').forEach(item => item.addEventListener("click", () => showAuthView(item.dataset.authView)));
      $$('[data-legal-view]').forEach(item => item.addEventListener('click', event => { event.preventDefault(); showLegalView(item.dataset.legalView); }));
      $$('[data-close-legal]').forEach(item => item.addEventListener('click', closeLegalView));
      $$('.add-client-trigger').forEach(button => button.addEventListener("click", () => openClientModal()));
      $$('.close-layer').forEach(button => button.addEventListener("click", closeLayers));
      $("#overlay").addEventListener("click", closeLayers);
      $("#add-beneficiary").addEventListener("click", () => addBeneficiaryRow());
      $("#home-search").addEventListener("input", renderHome);
      $("#home-sort").addEventListener("change", renderHome);
      $("#clients-search").addEventListener("input", renderClients);
      $("#consultation-filter").addEventListener("change", renderConsultations);
      $("#clear-search").addEventListener("click", () => { $("#home-search").value = ""; renderHome(); $("#home-search").focus(); });
      $("#menu-toggle").addEventListener("click", event => {
        event.stopPropagation();
        const menu = $("#header-menu");
        const open = menu.classList.toggle("open");
        $("#menu-toggle").setAttribute("aria-expanded", String(open));
        $("#menu-toggle").setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
        document.body.classList.toggle("menu-open", open);
      });
      $("#header-menu").addEventListener("click", event => event.stopPropagation());
      document.addEventListener("click", closeHeaderMenu);
      document.addEventListener("keydown", event => { if (event.key === "Escape") { if (document.body.classList.contains("legal-open")) closeLegalView(); else closeHeaderMenu(); } });
      $("#copyright-year").textContent = new Date().getFullYear();
      $("#record-from-page").addEventListener("click", () => openConsultationModal());
      $("#consult-client").addEventListener("change", () => populatePersonSelect());
      $("#open-pdf-export").addEventListener("click", openPdfExportModal);
      $("#pdf-select-all-aids").addEventListener("click", () => { $$('#pdf-medical-aid-list input[type="checkbox"]').forEach(input => input.checked = true); updatePdfAidHint(); });
      $("#pdf-clear-aids").addEventListener("click", () => { $$('#pdf-medical-aid-list input[type="checkbox"]').forEach(input => input.checked = false); updatePdfAidHint(); });
      $("#pdf-date-from").addEventListener("change", updatePdfExportSummary);
      $("#pdf-date-to").addEventListener("change", updatePdfExportSummary);
      $("#pdf-date-mode").addEventListener("change", updatePdfExportSummary);
      $("#pdf-export-form").addEventListener("submit", event => { event.preventDefault(); downloadPatientRegisterPdf(); });

      // Authentication
      $("#crypto-form").addEventListener("submit", async event => {
        event.preventDefault();
        if (!currentUser || !currentPractice) return;
        clearAuthMessage("#crypto-message");
        const form = new FormData(event.currentTarget);
        const passphrase = String(form.get("passphrase") || "");
        const confirm = String(form.get("confirm") || "");
        if (passphrase.length < 12) {
          showAuthMessage("#crypto-message", "Use an encryption passphrase of at least 12 characters.", true);
          return;
        }
        if (cryptoSetupMode === "setup" && passphrase !== confirm) {
          showAuthMessage("#crypto-message", "The encryption passphrases do not match.", true);
          return;
        }
        const button = $("#crypto-submit");
        const normalText = cryptoSetupMode === "setup" ? "Enable encryption" : "Unlock patient data";
        setButtonBusy(button, true, cryptoSetupMode === "setup" ? "Encrypting surgery…" : "Unlocking…", normalText);
        try {
          if (cryptoSetupMode === "setup") await createPracticeCrypto(passphrase);
          else await unlockPracticeCrypto(passphrase);
          $("#crypto-passphrase").value = "";
          $("#crypto-confirm").value = "";
          await finishEnterApp();
          showToast(cryptoSetupMode === "setup" ? "Patient encryption enabled" : "Patient data unlocked");
        } catch (error) {
          console.error(error);
          showAuthMessage("#crypto-message", error.message || "Could not unlock encrypted patient data.", true);
          dataEncryptionKey = null;
          blindIndexKey = null;
        } finally {
          setButtonBusy(button, false, "Unlocking…", normalText);
        }
      });

      $("#crypto-signout").addEventListener("click", async () => {
        clearCryptoKeys();
        await supabaseClient.auth.signOut();
      });

      $("#login-form").addEventListener("submit", async event => {
        event.preventDefault();
        clearAuthMessage("#login-message");
        const form = new FormData(event.currentTarget);
        const button = $("#login-submit");
        setButtonBusy(button, true, "Signing in…", "Login to Admin Control");
        const { error } = await supabaseClient.auth.signInWithPassword({
          email: String(form.get("email")).trim(),
          password: String(form.get("password"))
        });
        if (error) showAuthMessage("#login-message", error.message, true);
        setButtonBusy(button, false, "Signing in…", "Login to Admin Control");
      });

      $("#sign-out-menu").addEventListener("click", async () => {
        closeHeaderMenu();
        await supabaseClient.auth.signOut();
      });
      $("#database-signout").addEventListener("click", async () => supabaseClient.auth.signOut());
      $("#database-retry").addEventListener("click", async () => {
        const { data } = await supabaseClient.auth.getUser();
        if (data.user) await enterApp(data.user, true);
      });

      // Patient form
      $("#client-form").addEventListener("submit", async event => {
        event.preventDefault();
        if (!currentPractice) return;
        const form = new FormData(event.currentTarget);
        const fileNumber = String(form.get("fileNumber")).trim();
        if (records.some(client => client.id !== editingClientId && client.fileNumber.toLowerCase() === fileNumber.toLowerCase())) {
          showToast("That file number already exists");
          $("#client-file").focus();
          return;
        }

        const beneficiaries = $$('.beneficiary-form-row').map(row => ({
          id: row.dataset.beneficiaryId || null,
          name: $(".beneficiary-name-input", row).value.trim(),
          fileNumber: $(".beneficiary-file-input", row).value.trim(),
          relationship: $(".beneficiary-relation-input", row).value
        })).filter(person => person.name);

        const patientData = {
          name: String(form.get("name")).trim(),
          idNumber: String(form.get("idNumber")).trim(),
          fileNumber,
          medicalAid: String(form.get("medicalAid")).trim(),
          medicalAidNumber: String(form.get("medicalAidNumber") || "").trim(),
          plan: String(form.get("plan")).trim()
        };
        const button = $("#client-form button[type=\"submit\"]");
        const normalText = editingClientId ? "Save changes" : "Save client";
        setButtonBusy(button, true, "Saving…", normalText);

        try {
          let clientId;
          if (editingClientId) {
            const client = records.find(item => item.id === editingClientId);
            if (!client) return;
            clientId = client.id;
            await updatePatient(client, patientData, beneficiaries);
          } else {
            clientId = await createPatient(patientData, beneficiaries);
          }
          editingClientId = null;
          closeLayers();
          await refreshWorkspace(clientId);
          showToast(`${patientData.name} was ${normalText === "Save changes" ? "updated" : "added"}`);
        } catch (error) {
          console.error(error);
          if (error.code === "23505") showToast("That file number already exists");
          else showToast(error.message || "Could not save patient");
        } finally {
          setButtonBusy(button, false, "Saving…", normalText);
        }
      });

      // Consultation form
      $("#consultation-form").addEventListener("submit", async event => {
        event.preventDefault();
        if (!currentPractice) return;
        const form = new FormData(event.currentTarget);
        const client = records.find(item => item.id === form.get("clientId"));
        if (!client) return;
        const [personType, personId] = String(form.get("personKey")).split(":");
        const person = personType === "client" ? { name: client.name } : client.beneficiaries.find(item => item.id === personId);
        if (!person) return;
        const button = $("#consultation-form button[type=\"submit\"]");
        setButtonBusy(button, true, "Saving visit…", "Record visit");
        try {
          const consultationId = makeUUID();
          const encryptedConsultation = await encryptPayload("consultation", consultationId, {
            date: String(form.get("date")),
            personName: person.name,
            type: String(form.get("type")),
            notes: String(form.get("notes")).trim()
          });
          const inserted = await supabaseClient.from("consultations").insert({
            id: consultationId,
            practice_id: currentPractice.id,
            patient_id: client.id,
            beneficiary_id: personType === "beneficiary" ? personId : null,
            person_type: personType,
            person_name: null,
            visit_date: null,
            visit_type: null,
            notes: null,
            encrypted_payload: encryptedConsultation
          });
          if (inserted.error) throw inserted.error;
          closeLayers();
          await refreshWorkspace(client.id);
          showToast(`Consultation recorded for ${person.name}`);
        } catch (error) {
          console.error(error);
          showToast(error.message || "Could not record consultation");
        } finally {
          setButtonBusy(button, false, "Saving visit…", "Record visit");
        }
      });

      $("#export-data").addEventListener("click", async () => {
        if (!currentPractice || !currentCryptoProfile) return;
        const button = $("#export-data");
        setButtonBusy(button, true, "Preparing…", "Export");
        try {
          const raw = await fetchRawWorkspace();
          const blob = new Blob([JSON.stringify({
            format: "patient-desk-e2ee-backup",
            version: 1,
            exportedAt: new Date().toISOString(),
            practice: { id: currentPractice.id, name: currentPractice.name },
            crypto: {
              crypto_version: currentCryptoProfile.crypto_version,
              kdf: currentCryptoProfile.kdf,
              kdf_iterations: currentCryptoProfile.kdf_iterations,
              kdf_salt: currentCryptoProfile.kdf_salt,
              wrap_alg: currentCryptoProfile.wrap_alg,
              wrap_iv: currentCryptoProfile.wrap_iv,
              wrapped_dek: currentCryptoProfile.wrapped_dek
            },
            records: raw
          }, null, 2)], { type: "application/json" });
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = `patient-desk-encrypted-backup-${todayISO()}.json`;
          link.click();
          URL.revokeObjectURL(link.href);
          showToast("Encrypted backup downloaded");
        } catch (error) {
          console.error(error);
          showToast(error.message || "Could not create encrypted backup");
        } finally {
          setButtonBusy(button, false, "Preparing…", "Export");
        }
      });

      $("#lock-data").addEventListener("click", () => {
        lockPatientData(true);
      });

      document.addEventListener("keydown", event => {
        if (event.key === "Escape") closeLayers();
        if (currentUser && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          closeLayers();
          showView("home");
          $("#home-search").focus();
        }
      });

      supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT" || !session) {
          lockApp();
          return;
        }
        if (event === "SIGNED_IN" || event === "USER_UPDATED") {
          setTimeout(() => enterApp(session.user), 0);
        }
      });

      async function initialize() {
        initializeDate();
        document.body.classList.add("auth-signed-out");
        renderAll();
        setEncryptionStatus();
        try {
          const { data, error } = await supabaseClient.auth.getSession();
          if (error) throw error;
          if (data.session?.user) await enterApp(data.session.user);
          else showAuthView("login");
        } catch (error) {
          console.error(error);
          showAuthView("login");
          showAuthMessage("#login-message", "Could not connect to Supabase. Check your internet connection and try again.", true);
        }
      }

      initialize();
    })();
