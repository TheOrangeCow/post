(() => {
    const TRANSPORT_LABEL = { local: 'Local delivery', road: 'By road', air: 'By air' };
    const POLL_MS = 5000;

    let identity = null;
    let letters = [];
    let activeTab = 'compose';
    let tickTimer = null;
    let pollTimer = null;

    const el = (id) => document.getElementById(id);

    async function boot() {
        try {
            const res = await fetch('/api/session');
            const data = await res.json();
            if (data.loggedIn) {
                identity = { name: data.name, address: data.address };
                startApp();
                return;
            }
        } catch (e) {}
        showSetupScreen();
    }

    function showSetupScreen() {
        el('setup-screen').classList.remove('hidden');
        el('app').classList.add('hidden');
    }

    function startApp() {
        el('setup-screen').classList.add('hidden');
        el('app').classList.remove('hidden');
        el('identity-name').textContent = identity.name;
        el('identity-address').textContent = identity.address;
        refreshMailbox();
        if (pollTimer) clearInterval(pollTimer);
        if (tickTimer) clearInterval(tickTimer);
        pollTimer = setInterval(refreshMailbox, POLL_MS);
        tickTimer = setInterval(renderActivePane, 1000);
    }

    document.querySelectorAll('.setup-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.setup-tab').forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            const mode = tab.dataset.mode;
            el('signup-form').classList.toggle('hidden', mode !== 'signup');
            el('login-form').classList.toggle('hidden', mode !== 'login');
            el('setup-heading').textContent = mode === 'signup' ? 'Create your address' : 'Welcome back';
            el('setup-copy').textContent = mode === 'signup'
                ? "Post is slow on purpose. Letters travel for as long as they would in real life, so you'll need a real address and a password to protect it."
                : 'Enter the address and password you signed up with.';
        });
    });

    function getDeviceLocation() {
        return new Promise((resolve) => {
            if (!('geolocation' in navigator)) { resolve(null); return; }
            const timeout = setTimeout(() => resolve(null), 6000);
            navigator.geolocation.getCurrentPosition(
                (pos) => { clearTimeout(timeout); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
                () => { clearTimeout(timeout); resolve(null); },
                { timeout: 5500, maximumAge: 300000 }
            );
        });
    }

    el('signup-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = el('signup-error');
        errorEl.hidden = true;

        const password = el('su-password').value;
        const confirm = el('su-password-confirm').value;
        if (password !== confirm) {
            errorEl.textContent = "Those passwords don't match.";
            errorEl.hidden = false;
            return;
        }

        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Checking your address…';

        const device = await getDeviceLocation();

        const payload = {
            name: el('su-name').value.trim(),
            line1: el('su-line1').value.trim(),
            line2: el('su-line2').value.trim(),
            city: el('su-city').value.trim(),
            postcode: el('su-postcode').value.trim(),
            country: el('su-country').value.trim(),
            password,
            device_lat: device ? device.lat : null,
            device_lng: device ? device.lng : null,
        };

        try {
            const res = await fetch('/api/account/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) {
                errorEl.textContent = data.error || 'Something went wrong. Please try again.';
                errorEl.hidden = false;
                return;
            }
            identity = { name: data.name, address: data.address };
            startApp();
            if (data.locationWarning) {
                showToast(data.locationWarning);
            }
        } catch (err) {
            errorEl.textContent = 'Could not reach the server. Please try again.';
            errorEl.hidden = false;
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create address';
        }
    });

    //Login 
    el('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = el('login-error');
        errorEl.hidden = true;

        const payload = {
            line1: el('li-line1').value.trim(),
            city: el('li-city').value.trim(),
            postcode: el('li-postcode').value.trim(),
            country: el('li-country').value.trim(),
            password: el('li-password').value,
        };

        try {
            const res = await fetch('/api/account/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) {
                errorEl.textContent = data.error || 'Could not log in.';
                errorEl.hidden = false;
                return;
            }
            identity = { name: data.name, address: data.address };
            startApp();
        } catch (err) {
            errorEl.textContent = 'Could not reach the server. Please try again.';
            errorEl.hidden = false;
        }
    });

    //Logout
    el('identity-chip').addEventListener('click', async () => {
        if (pollTimer) clearInterval(pollTimer);
        if (tickTimer) clearInterval(tickTimer);
        try { await fetch('/api/account/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
        identity = null;
        letters = [];
        document.querySelectorAll('.setup-tab').forEach((t) => t.classList.remove('active'));
        document.querySelector('.setup-tab[data-mode="login"]').classList.add('active');
        el('signup-form').classList.add('hidden');
        el('login-form').classList.remove('hidden');
        showSetupScreen();
    });

    //Tabs
    document.querySelectorAll('.hole').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.hole').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            activeTab = btn.dataset.tab;
            ['compose', 'outbox', 'inbox'].forEach((tab) => {
                el(`pane-${tab}`).classList.toggle('hidden', tab !== activeTab);
            });
            renderActivePane();
        });
    });

    //Fetch mailbox
    async function refreshMailbox() {
        if (!identity) return;
        try {
            const res = await fetch('/api/mailbox');
            if (res.status === 401) { showSetupScreen(); return; }
            if (!res.ok) return;
            const fresh = await res.json();
            detectNewArrivals(letters, fresh);
            letters = fresh;
            renderActivePane();
            updateCounts();
        } catch (e) {}
    }

    function detectNewArrivals(oldLetters, newLetters) {
        if (!oldLetters.length) return;
        const oldMap = new Map(oldLetters.map((l) => [l.id, l]));
        newLetters.forEach((l) => {
            const prev = oldMap.get(l.id);
            if (prev && !prev.delivered && l.delivered && l.direction === 'received') {
                showToast(`A letter from ${l.sender_name} has arrived.`);
            }
        });
    }

    function updateCounts() {
        const outCount = letters.filter((l) => l.direction === 'sent' && !l.delivered).length;
        const inCount = letters.filter((l) => l.direction === 'received' && l.delivered && !l.opened).length;
        const outBadge = el('outbox-count');
        const inBadge = el('inbox-count');
        outBadge.hidden = outCount === 0;
        outBadge.textContent = outCount;
        inBadge.hidden = inCount === 0;
        inBadge.textContent = inCount;
    }

    // Rendering 
    function renderActivePane() {
        if (activeTab === 'outbox') renderList('outbox');
        if (activeTab === 'inbox') renderList('inbox');
    }

    function renderList(kind) {
        const listEl = el(`${kind}-list`);
        const emptyEl = el(`${kind}-empty`);
        const items = letters.filter((l) => (kind === 'outbox' ? l.direction === 'sent' : l.direction === 'received'));

        emptyEl.hidden = items.length > 0;
        listEl.innerHTML = '';

        items.forEach((l) => listEl.appendChild(renderCard(l, kind)));
    }

    function renderCard(letter, kind) {
        const card = document.createElement('div');
        card.className = 'letter-card';

        const other = kind === 'outbox' ? letter.recipient_name : letter.sender_name;
        const label = kind === 'outbox' ? `To ${other}` : `From ${other}`;

        const top = document.createElement('div');
        top.className = 'letter-card-top';
        top.innerHTML = `
      <div>
        <p class="letter-card-title">${escapeHtml(letter.subject || '(No subject)')}</p>
        <p class="letter-card-meta">${escapeHtml(label)}</p>
      </div>
      <span class="letter-card-class cls-${letter.stamp_class}">${letter.stamp_class} class</span>
    `;
        card.appendChild(top);

        if (!letter.delivered) {
            card.appendChild(renderRoute(letter));
        } else if (kind === 'outbox') {
            const tag = document.createElement('p');
            tag.className = 'delivered-tag';
            tag.textContent = `Delivered${letter.opened ? ' and read' : ''}`;
            card.appendChild(tag);
        } else {
            const btn = document.createElement('button');
            btn.className = 'open-button' + (letter.opened ? '' : ' unread');
            btn.textContent = letter.opened ? 'Read again' : 'Open letter';
            btn.addEventListener('click', () => openReadOverlay(letter));
            card.appendChild(btn);
        }

        return card;
    }

    function renderRoute(letter) {
        const wrap = document.createElement('div');

        const route = document.createElement('div');
        route.className = 'route';
        const pct = Math.round(letter.progress * 100);
        route.innerHTML = `
      <div class="route-line"></div>
      <span class="route-node start"></span>
      <span class="route-node end"></span>
      <span class="route-marker" style="left:${2 + pct * 0.96}%"></span>
    `;
        wrap.appendChild(route);

        const caption = document.createElement('div');
        caption.className = 'transit-caption';
        const remaining = formatRemaining(letter.seconds_remaining);
        const arrival = formatArrival(letter.delivery_at);
        caption.innerHTML = `
      <span>${letter.distance} miles · ${TRANSPORT_LABEL[letter.transport] || 'In transit'}</span>
      <span>${remaining} · arrives ${arrival}</span>
    `;
        wrap.appendChild(caption);

        return wrap;
    }

    function formatRemaining(seconds) {
        if (seconds <= 0) return 'arriving';
        const mins = Math.floor(seconds / 60);
        const hrs = Math.floor(mins / 60);
        const days = Math.floor(hrs / 24);
        if (days > 0) return `${days}d ${hrs % 24}h left`;
        if (hrs > 0) return `${hrs}h ${mins % 60}m left`;
        if (mins > 0) return `${mins}m left`;
        return `${Math.ceil(seconds)}s left`;
    }

    function formatArrival(epochSeconds) {
        const d = new Date(epochSeconds * 1000);
        return d.toLocaleString(undefined, {
            weekday: 'short', day: 'numeric', month: 'short',
            hour: '2-digit', minute: '2-digit',
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    // Send
    el('compose-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = el('compose-error');
        errorEl.hidden = true;

        const payload = {
            recipient_name: el('recipient-name').value.trim(),
            r_line1: el('r-line1').value.trim(),
            r_line2: el('r-line2').value.trim(),
            r_city: el('r-city').value.trim(),
            r_postcode: el('r-postcode').value.trim(),
            r_country: el('r-country').value.trim(),
            subject: el('subject').value.trim(),
            message: el('message').value.trim(),
            stamp_class: document.querySelector('input[name="stamp_class"]:checked').value,
        };

        const sendBtn = el('send-button');
        sendBtn.disabled = true;
        playSendAnimation();

        try {
            const res = await fetch('/api/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();

            if (!res.ok) {
                hideSendOverlay();
                errorEl.textContent = data.error || 'Something went wrong. Please try again.';
                errorEl.hidden = false;
                sendBtn.disabled = false;
                return;
            }

            setTimeout(() => {
                el('send-detail').textContent =
                    `${data.distance} miles, ${TRANSPORT_LABEL[data.transport] || 'in transit'} — ` +
                    `about ${data.transit_days} day${data.transit_days === 1 ? '' : 's'}. ` +
                    `Expected to arrive ${formatArrival(data.delivery_at)}.`;
                el('send-overlay-close').classList.remove('hidden');
            }, 2200);

            el('compose-form').reset();
            document.querySelector('input[name="stamp_class"][value="1st"]').checked = true;
            refreshMailbox();
        } catch (err) {
            hideSendOverlay();
            errorEl.textContent = 'Could not reach the sorting office. Please try again.';
            errorEl.hidden = false;
        } finally {
            sendBtn.disabled = false;
        }
    });

    function playSendAnimation() {
        const overlay = el('send-overlay');
        const letterSlip = el('anim-letter');
        const flap = el('anim-flap');
        const stamp = el('anim-stamp');
        const postmark = el('anim-postmark');
        const caption = el('send-caption');
        const detail = el('send-detail');

        [letterSlip, flap, stamp, postmark].forEach((node) => {
            node.style.animation = 'none';
            void node.offsetWidth;
            node.style.animation = '';
        });

        caption.textContent = 'Sealing your letter…';
        detail.textContent = '';
        el('send-overlay-close').classList.add('hidden');
        overlay.classList.remove('hidden');

        setTimeout(() => { caption.textContent = 'Franking the stamp…'; }, 1200);
        setTimeout(() => { caption.textContent = 'Off to the sorting office…'; }, 2100);
    }

    el('send-overlay-close').addEventListener('click', hideSendOverlay);
    function hideSendOverlay() {
        el('send-overlay').classList.add('hidden');
    }

    let readingLetter = null;

    function openReadOverlay(letter) {
        readingLetter = letter;
        const envelope = el('read-envelope');
        const page = el('letter-page');
        envelope.classList.remove('open');
        page.classList.add('hidden');
        el('read-hint').textContent = 'Tap the envelope to open';
        el('read-overlay').classList.remove('hidden');
    }

    el('read-envelope').addEventListener('click', async () => {
        const envelope = el('read-envelope');
        if (envelope.classList.contains('open') || !readingLetter) return;
        envelope.classList.add('open');

        setTimeout(async () => {
            el('letter-meta').textContent =
                `From ${readingLetter.sender_name} · ${readingLetter.stamp_class} class · ${readingLetter.distance} miles`;
            el('letter-subject').textContent = readingLetter.subject || '(No subject)';
            el('letter-body').textContent = readingLetter.message || '';
            el('letter-sign').textContent = `— ${readingLetter.sender_name}`;
            el('letter-page').classList.remove('hidden');

            if (!readingLetter.opened) {
                readingLetter.opened = true;
                try {
                    await fetch(`/api/open/${readingLetter.id}`, { method: 'POST' });
                } catch (e) { }
                renderActivePane();
                updateCounts();
            }
        }, 450);
    });

    el('read-overlay-close').addEventListener('click', () => {
        el('read-overlay').classList.add('hidden');
        readingLetter = null;
    });

    // Toast 
    let toastTimer = null;
    function showToast(message) {
        const toast = el('toast');
        toast.textContent = message;
        toast.hidden = false;
        toast.style.animation = 'none';
        void toast.offsetWidth;
        toast.style.animation = '';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.hidden = true; }, 5200);
    }

    boot();
})();
