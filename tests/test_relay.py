import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from fastapi.testclient import TestClient
from main import app, ROOMS


def test_assets_and_origin():
    with TestClient(app) as c:
        for path in ['/', '/compact.css', '/coach.js', '/sensing.js', '/vision-worker.js', '/vendor/vision_bundle.js']:
            assert c.get(path).status_code == 200
        assert c.post('/api/session', headers={'Origin': 'https://unrelated.example'}).status_code == 403


def test_real_room_relay_and_authority():
    with TestClient(app) as c:
        session = c.post('/api/session').json()
        room, key = session['room'], session['controller_key']
        assert c.post(f'/api/git-commit-hook/{room}').status_code == 403
        with c.websocket_connect(f'/ws/{room}?role=pc&key={key}') as pc:
            assert pc.receive_json()['pc_online'] is True
            with c.websocket_connect(f'/ws/{room}?role=phone') as phone:
                assert phone.receive_json()['phones'] == 1
                assert pc.receive_json()['phones'] == 1
                pc.send_json({'type': 'intervene', 'mode': 'buddy', 'event_id': 'one', 'score': 35, 'reason': '姿勢の変化'})
                assert phone.receive_json()['event_id'] == 'one'
                pc.receive_json()
                phone.send_json({'type': 'start', 'exercise': 'banzai'})
                assert pc.receive_json() == {'type': 'command', 'action': 'start', 'exercise': 'banzai'}
                # A phone cannot forge a recovered measurement or overwrite the PC state.
                phone.send_json({'type': 'recovered', 'mode': 'standby', 'score': 100})
                phone.send_json({'type': 'ping'})
                assert phone.receive_json()['type'] == 'pong'
                assert ROOMS[room]['state']['score'] == 35
                response = c.post(f'/api/git-commit-hook/{room}', headers={'X-Controller-Key': key})
                assert response.status_code == 200
                assert pc.receive_json()['action'] == 'commit'
                phone.send_text('{broken')
                assert phone.receive_json()['type'] == 'error'
                second = c.post('/api/session').json()
                assert second['room'] != room
                assert ROOMS[second['room']]['state']['score'] == 100


def test_reconnect_replays_only_active_notice():
    with TestClient(app) as c:
        session = c.post('/api/session').json()
        room, key = session['room'], session['controller_key']
        with c.websocket_connect(f'/ws/{room}?role=pc&key={key}') as pc:
            pc.receive_json()
            pc.send_json({'type': 'intervene', 'mode': 'buddy', 'event_id': 'stable-id'})
            pc.receive_json()
            with c.websocket_connect(f'/ws/{room}?role=phone') as phone:
                assert phone.receive_json()['mode'] == 'buddy'
                assert phone.receive_json()['event_id'] == 'stable-id'
                pc.receive_json()
                pc.send_json({'type': 'state', 'mode': 'ambient'})
                assert phone.receive_json()['mode'] == 'ambient'
                pc.receive_json()
                assert ROOMS[room]['last_event'] is None


def test_commit_hook_is_rate_limited():
    with TestClient(app) as c:
        session = c.post('/api/session').json()
        room, key = session['room'], session['controller_key']
        with c.websocket_connect(f'/ws/{room}?role=pc&key={key}') as pc:
            pc.receive_json()
            first = c.post(f'/api/git-commit-hook/{room}', headers={'X-Controller-Key': key})
            second = c.post(f'/api/git-commit-hook/{room}', headers={'X-Controller-Key': key})
            assert first.status_code == 200
            assert second.status_code == 429


def test_expired_room_is_rejected_and_open_socket_is_closed():
    from starlette.websockets import WebSocketDisconnect
    from main import TTL
    with TestClient(app) as c:
        session = c.post('/api/session').json()
        room, key = session['room'], session['controller_key']
        with c.websocket_connect(f'/ws/{room}?role=pc&key={key}') as pc:
            pc.receive_json()
            ROOMS[room]['created'] -= TTL + 10  # simulate 12h passing
            pc.send_json({'type': 'state', 'mode': 'ambient'})
            disconnected = False
            try:
                pc.receive_json()
            except WebSocketDisconnect:
                disconnected = True
            assert disconnected
        assert c.post(f'/api/git-commit-hook/{room}', headers={'X-Controller-Key': key}).status_code == 404


def test_desktop_guard_is_loopback_only_and_expires(monkeypatch):
    import main as main_module
    with TestClient(app) as c:
        assert c.post('/api/posture-guard/update', json={'source': 'browser-one', 'active': True}).status_code == 403
        assert c.get('/api/posture-guard/state').status_code == 403
        assert c.post('/api/posture-guard/dismiss').status_code == 403
        monkeypatch.setattr(main_module, 'require_local_pc', lambda request: None)
        main_module.DESKTOP_GUARD.clear()
        assert c.post('/api/posture-guard/update', json={'source': 'browser-one', 'active': True, 'score': 38}).status_code == 200
        assert c.get('/api/posture-guard/state').json() == {'active': True, 'score': 38, 'playful': True, 'pause_on_kittens': False, 'face_close': False, 'grow': True}
        assert c.post('/api/posture-guard/update', json={'source': 'browser-two', 'active': False}).status_code == 200
        assert c.get('/api/posture-guard/state').json()['active'] is True
        main_module.DESKTOP_GUARD['browser-one']['seen'] -= main_module.GUARD_TTL + 1
        assert c.get('/api/posture-guard/state').json() == {'active': False, 'score': None, 'playful': False, 'pause_on_kittens': False, 'face_close': False, 'grow': False}


def test_desktop_cat_score_is_validated_and_updates_without_warning(monkeypatch):
    import main as main_module
    monkeypatch.setattr(main_module, 'require_local_pc', lambda request: None)
    main_module.DESKTOP_GUARD.clear()
    with TestClient(app) as c:
        for invalid in (-1, 101, 'unavailable'):
            assert c.post('/api/posture-guard/update', json={
                'source': 'browser-camera', 'active': False, 'score': invalid}).status_code == 422
        # A healthy measured posture shows a small cat without a timed warning.
        assert c.post('/api/posture-guard/update', json={
            'source': 'browser-camera', 'active': False, 'score': 96}).status_code == 200
        assert c.get('/api/posture-guard/state').json() == {'active': False, 'score': 96, 'playful': True, 'pause_on_kittens': False, 'face_close': False, 'grow': True}
        assert c.post('/api/posture-guard/update', json={
            'source': 'browser-camera', 'active': False, 'score': 42,
            'playful': False, 'pause_on_kittens': True}).status_code == 200
        assert c.get('/api/posture-guard/state').json()['score'] == 42
        assert c.get('/api/posture-guard/state').json()['playful'] is False
        assert c.get('/api/posture-guard/state').json()['pause_on_kittens'] is True
        # Turning off the camera hides the cat immediately.
        assert c.post('/api/posture-guard/update', json={
            'source': 'browser-camera', 'active': False, 'score': None}).status_code == 200
        assert c.get('/api/posture-guard/state').json()['score'] is None


def test_face_warning_zoom_hint_and_dismiss_counter(monkeypatch):
    import main as main_module
    monkeypatch.setattr(main_module, 'require_local_pc', lambda request: None)
    main_module.DESKTOP_GUARD.clear()
    main_module.GUARD_EVENTS['dismissals'] = 0
    with TestClient(app) as c:
        payload = {'source': 'face-camera', 'active': False, 'score': None,
                   'face_close': True, 'grow': True, 'playful': False, 'zoom_hint': True}
        res = c.post('/api/posture-guard/update', json=payload).json()
        assert res['ok'] is True and res['dismissals'] == 0
        state = c.get('/api/posture-guard/state').json()
        assert state['face_close'] is True
        assert state['zoom_hint'] is True
        assert state['score'] is None
        assert state['grow'] is True
        dismiss_res = c.post('/api/posture-guard/dismiss').json()
        assert dismiss_res['dismissals'] == 1
        res_after = c.post('/api/posture-guard/update', json=payload).json()
        assert res_after['dismissals'] == 1
        main_module.DESKTOP_GUARD['face-camera']['seen'] -= main_module.GUARD_TTL + 1
        state = c.get('/api/posture-guard/state').json()
        assert state['face_close'] is False
        assert state.get('zoom_hint') is None
        assert state['grow'] is False
        payload['face_close'] = False
        payload['zoom_hint'] = False
        assert c.post('/api/posture-guard/update', json=payload).status_code == 200
        assert c.get('/api/posture-guard/state').json()['face_close'] is False


if __name__ == '__main__':
    class _MonkeyPatch:
        def __init__(self):
            self._undo = []
        def setattr(self, obj, name, val):
            old = getattr(obj, name)
            self._undo.append((obj, name, old))
            setattr(obj, name, val)
        def restore(self):
            for obj, name, old in reversed(self._undo):
                setattr(obj, name, old)
            self._undo.clear()

    mp = _MonkeyPatch()
    for fn in (
        test_assets_and_origin,
        test_real_room_relay_and_authority,
        test_reconnect_replays_only_active_notice,
        test_commit_hook_is_rate_limited,
        test_expired_room_is_rejected_and_open_socket_is_closed,
        lambda: test_desktop_guard_is_loopback_only_and_expires(mp),
        lambda: test_desktop_cat_score_is_validated_and_updates_without_warning(mp),
        lambda: test_face_warning_zoom_hint_and_dismiss_counter(mp),
    ):
        try:
            fn()
        finally:
            mp.restore()
    print('PASS: all relay and desktop guard API tests')
