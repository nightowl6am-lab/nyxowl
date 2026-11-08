from fastapi import APIRouter

router = APIRouter(prefix="/api/v1")
admin = APIRouter()


@router.get("/items")
def list_items():
    return {"id": 1, "name": "widget"}


@router.post("/items/{item_id}")
def create_item(item_id: int):
    return build_item(item_id)


@router.put("/items/{item_id}")
async def update_item(item_id: int):
    return {"updated": True, "item_id": item_id}


@admin.delete("/admin/{item_id}")
def delete_item(item_id: int):
    return {"deleted": item_id}
