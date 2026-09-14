from flask import Flask, request, jsonify, render_template, session
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3
import time
import math
import threading
import urllib.parse
import urllib.request
import json
import os
from datetime import datetime, timedelta

app = Flask(__name__)
app.secret_key = os.environ.get('POST_SECRET_KEY', 'dev-secret-key-change-me')

DB_PATH = os.path.join(os.path.dirname(__file__), 'mail.db')

_geocode_cache = {}
_geocode_lock = threading.Lock()
_last_geocode_call = 0.0
NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
NOMINATIM_USER_AGENT = 'PostLetterApp/1.0 (educational demo project)'


def geocode_address(line1, city, postcode, country):
    query = ', '.join(part for part in [line1, city, postcode, country] if part)
    cache_key = query.strip().lower()
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    params = urllib.parse.urlencode({'q': query, 'format': 'json', 'limit': 1})
    url = f'{NOMINATIM_URL}?{params}'
    req = urllib.request.Request(url, headers={'User-Agent': NOMINATIM_USER_AGENT})

    with _geocode_lock:
        global _last_geocode_call
        wait = 1.1 - (time.time() - _last_geocode_call)
        if wait > 0:
            time.sleep(wait)
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                results = json.loads(resp.read().decode('utf-8'))
        except Exception:
            _last_geocode_call = time.time()
            return None
        _last_geocode_call = time.time()

    if not results:
        return None

    lat = float(results[0]['lat'])
    lng = float(results[0]['lon'])
    _geocode_cache[cache_key] = (lat, lng)
    return (lat, lng)

def haversine_miles(lat1, lng1, lat2, lng2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)))

def clean_text(value):
    return ' '.join((value or '').strip().lower().split())

def clean_postcode(value):
    return ''.join((value or '').strip().lower().split())

def address_key(line1, city, postcode, country):
    return '|'.join([clean_text(line1), clean_text(city), clean_postcode(postcode), clean_text(country)])

def format_address(line1, line2, city, postcode, country):
    parts = [line1]
    if line2:
        parts.append(line2)
    parts += [city, postcode, country]
    return ', '.join(p for p in parts if p)

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS accounts (
            address_key TEXT PRIMARY KEY,
            display_address TEXT,
            name TEXT,
            password_hash TEXT,
            line1 TEXT, line2 TEXT, city TEXT, postcode TEXT, country TEXT,
            lat REAL, lng REAL,
            created_at REAL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS letters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_name TEXT,
            sender_key TEXT,
            sender_display_address TEXT,
            recipient_name TEXT,
            recipient_key TEXT,
            recipient_display_address TEXT,
            subject TEXT,
            message TEXT,
            stamp_class TEXT,
            created_at REAL,
            delivery_at REAL,
            transit_days REAL,
            distance INTEGER,
            transport TEXT,
            opened INTEGER DEFAULT 0
        )
    ''')
    conn.commit()
    conn.close()

def compute_transit_days(distance_miles, stamp_class, same_country):
    if same_country:
        if stamp_class == '1st':
            return 1.0
        return 3.0 if distance_miles > 150 else 2.0
    if stamp_class == '1st':
        return round(3 + distance_miles / 2000, 2)
    return round(7 + distance_miles / 1000, 2)

def pick_transport(distance_miles, same_country):
    if not same_country:
        return 'air'
    if distance_miles > 120:
        return 'road'
    return 'local'

def compute_delivery_at(created_at_epoch, transit_days):
    created_dt = datetime.fromtimestamp(created_at_epoch)
    delivery_dt = created_dt + timedelta(days=transit_days)
    if delivery_dt.weekday() == 6:
        delivery_dt += timedelta(days=1)
    return delivery_dt.timestamp()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/session')
def get_session():
    key = session.get('address_key')
    if not key:
        return jsonify({'loggedIn': False})
    conn = get_db()
    row = conn.execute('SELECT name, display_address FROM accounts WHERE address_key=?', (key,)).fetchone()
    conn.close()
    if not row:
        session.clear()
        return jsonify({'loggedIn': False})
    return jsonify({'loggedIn': True, 'name': row['name'], 'address': row['display_address']})

@app.route('/api/account/signup', methods=['POST'])
def signup():
    data = request.get_json(force=True) or {}
    name = (data.get('name') or '').strip()[:60]
    password = data.get('password') or ''
    line1 = (data.get('line1') or '').strip()[:120]
    line2 = (data.get('line2') or '').strip()[:120]
    city = (data.get('city') or '').strip()[:80]
    postcode = (data.get('postcode') or '').strip()[:20]
    country = (data.get('country') or '').strip()[:60]
    device_lat = data.get('device_lat')
    device_lng = data.get('device_lng')

    if not name or not line1 or not city or not postcode or not country:
        return jsonify({'error': 'Please fill in your name and full address.'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Choose a password with at least 6 characters.'}), 400

    key = address_key(line1, city, postcode, country)

    conn = get_db()
    existing = conn.execute('SELECT 1 FROM accounts WHERE address_key=?', (key,)).fetchone()
    if existing:
        conn.close()
        return jsonify({'error': 'An address already exists with those details. Try logging in instead.'}), 400

    coords = geocode_address(line1, city, postcode, country)
    if not coords:
        conn.close()
        return jsonify({'error': "We couldn't find that address. Check it's spelled correctly and try again."}), 400
    lat, lng = coords

    location_warning = None
    if device_lat is not None and device_lng is not None:
        try:
            distance_from_device = haversine_miles(float(device_lat), float(device_lng), lat, lng)
            if distance_from_device > 60:
                location_warning = (
                    "Your device's current location is quite far from the address you entered. "
                    "This check can be based on your IP address rather than GPS, so it's often "
                    "unreliable on Wi-Fi or mobile networks - but it's worth double-checking your address."
                )
        except (TypeError, ValueError):
            pass

    display_address = format_address(line1, line2, city, postcode, country)
    conn.execute('''
        INSERT INTO accounts (address_key, display_address, name, password_hash,
            line1, line2, city, postcode, country, lat, lng, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ''', (key, display_address, name, generate_password_hash(password),
          line1, line2, city, postcode, country, lat, lng, time.time()))
    conn.commit()
    conn.close()

    session['address_key'] = key
    return jsonify({'ok': True, 'name': name, 'address': display_address, 'locationWarning': location_warning})

@app.route('/api/account/login', methods=['POST'])
def login():
    data = request.get_json(force=True) or {}
    line1 = (data.get('line1') or '').strip()
    city = (data.get('city') or '').strip()
    postcode = (data.get('postcode') or '').strip()
    country = (data.get('country') or '').strip()
    password = data.get('password') or ''

    key = address_key(line1, city, postcode, country)
    conn = get_db()
    row = conn.execute('SELECT * FROM accounts WHERE address_key=?', (key,)).fetchone()
    conn.close()

    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify({'error': 'No matching address and password combination was found.'}), 401

    session['address_key'] = key
    return jsonify({'ok': True, 'name': row['name'], 'address': row['display_address']})


@app.route('/api/account/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True})

def require_login():
    key = session.get('address_key')
    if not key:
        return None
    conn = get_db()
    row = conn.execute('SELECT * FROM accounts WHERE address_key=?', (key,)).fetchone()
    conn.close()
    return row

@app.route('/api/send', methods=['POST'])
def send_letter():
    account = require_login()
    if not account:
        return jsonify({'error': 'You need to be logged in to send a letter.'}), 401

    data = request.get_json(force=True) or {}
    recipient_name = (data.get('recipient_name') or '').strip()[:60]
    r_line1 = (data.get('r_line1') or '').strip()[:120]
    r_line2 = (data.get('r_line2') or '').strip()[:120]
    r_city = (data.get('r_city') or '').strip()[:80]
    r_postcode = (data.get('r_postcode') or '').strip()[:20]
    r_country = (data.get('r_country') or '').strip()[:60]
    subject = (data.get('subject') or '').strip()[:80] or '(No subject)'
    message = (data.get('message') or '').strip()[:4000]
    stamp_class = data.get('stamp_class')
    stamp_class = stamp_class if stamp_class in ('1st', '2nd') else '2nd'

    if not recipient_name or not r_line1 or not r_city or not r_postcode or not r_country or not message:
        return jsonify({'error': "Fill in the recipient's full address, a name, and your message."}), 400

    recipient_key = address_key(r_line1, r_city, r_postcode, r_country)
    if recipient_key == account['address_key']:
        return jsonify({'error': "You can't post a letter to your own address."}), 400

    coords = geocode_address(r_line1, r_city, r_postcode, r_country)
    if not coords:
        return jsonify({'error': "We couldn't find the recipient's address. Check it and try again."}), 400
    r_lat, r_lng = coords

    same_country = clean_text(r_country) == clean_text(account['country'])
    distance = haversine_miles(account['lat'], account['lng'], r_lat, r_lng)
    transit_days = compute_transit_days(distance, stamp_class, same_country)
    transport = pick_transport(distance, same_country)

    now = time.time()
    delivery_at = compute_delivery_at(now, transit_days)
    recipient_display = format_address(r_line1, r_line2, r_city, r_postcode, r_country)

    conn = get_db()
    cur = conn.execute('''
        INSERT INTO letters (sender_name, sender_key, sender_display_address,
            recipient_name, recipient_key, recipient_display_address,
            subject, message, stamp_class, created_at, delivery_at, transit_days,
            distance, transport, opened)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    ''', (account['name'], account['address_key'], account['display_address'],
          recipient_name, recipient_key, recipient_display,
          subject, message, stamp_class, now, delivery_at, transit_days,
          distance, transport))
    conn.commit()
    letter_id = cur.lastrowid
    conn.close()

    return jsonify({
        'id': letter_id,
        'distance': distance,
        'transit_days': transit_days,
        'delivery_at': delivery_at,
        'transport': transport,
    })

def letter_to_dict(row, viewer_key):
    now = time.time()
    delivered = now >= row['delivery_at']
    total_span = max(row['delivery_at'] - row['created_at'], 0.001)
    progress = min(1.0, max(0.0, (now - row['created_at']) / total_span))
    is_outgoing = row['sender_key'] == viewer_key

    return {
        'id': row['id'],
        'sender_name': row['sender_name'],
        'sender_address': row['sender_display_address'],
        'recipient_name': row['recipient_name'],
        'recipient_address': row['recipient_display_address'],
        'subject': row['subject'],
        'message': row['message'] if (delivered or is_outgoing) else None,
        'stamp_class': row['stamp_class'],
        'created_at': row['created_at'],
        'delivery_at': row['delivery_at'],
        'transit_days': row['transit_days'],
        'distance': row['distance'],
        'transport': row['transport'],
        'delivered': delivered,
        'progress': progress,
        'opened': bool(row['opened']),
        'direction': 'sent' if is_outgoing else 'received',
        'seconds_remaining': max(0, round(row['delivery_at'] - now, 1)),
    }

@app.route('/api/mailbox')
def mailbox():
    account = require_login()
    if not account:
        return jsonify({'error': 'You need to be logged in.'}), 401

    conn = get_db()
    rows = conn.execute('''
        SELECT * FROM letters
        WHERE recipient_key = ? OR sender_key = ?
        ORDER BY created_at DESC
    ''', (account['address_key'], account['address_key'])).fetchall()
    conn.close()
    letters = [letter_to_dict(r, account['address_key']) for r in rows]
    return jsonify(letters)

@app.route('/api/open/<int:letter_id>', methods=['POST'])
def open_letter(letter_id):
    account = require_login()
    if not account:
        return jsonify({'error': 'You need to be logged in.'}), 401
    conn = get_db()
    conn.execute('UPDATE letters SET opened = 1 WHERE id = ? AND recipient_key = ?',
                 (letter_id, account['address_key']))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5000)
else:
    init_db()
