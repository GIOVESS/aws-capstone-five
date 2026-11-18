import uuid


class FakeDb:
    def __init__(self):
        self.products = [{"id": 1, "name": "Lantern", "price_cents": 2200}]
        self.orders = {}
        self.list_calls = 0

    def ping(self): return True
    def list_products(self):
        self.list_calls += 1
        return list(self.products)
    def product_exists(self, pid): return any(p["id"] == pid for p in self.products)
    def create_order(self, pid, qty):
        oid = str(uuid.uuid4())
        self.orders[oid] = {"id": oid, "product_id": pid, "quantity": qty, "status": "PENDING",
                            "created_at": "t", "updated_at": "t"}
        return oid
    def get_order(self, oid): return self.orders.get(oid)
    def set_order_status(self, oid, st): self.orders[oid]["status"] = st
    def order_counts(self):
        out = {}
        for o in self.orders.values():
            out[o["status"]] = out.get(o["status"], 0) + 1
        return out


class FakeCache:
    def __init__(self, broken=False):
        self.store, self.broken = {}, broken
    def get_json(self, k): return None if self.broken else self.store.get(k)
    def set_json(self, k, v, ttl=None):
        if not self.broken: self.store[k] = v
    def ping(self): return not self.broken


class FakeQueue:
    def __init__(self, fail=False):
        self.sent, self.fail = [], fail
    def send(self, body):
        if self.fail: raise RuntimeError("sqs down")
        self.sent.append(body)
        return "m-1"
    def depth(self): return {"visible": len(self.sent), "in_flight": 0}
    def ping(self): return not self.fail
