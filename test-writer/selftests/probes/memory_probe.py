"""Probe: allocate 1 MiB blocks until the address-space limit is reached."""

blocks = []
try:
    for _ in range(1024):
        blocks.append(bytearray(1024 * 1024))
except MemoryError:
    # Free the retained blocks so printing the marker itself still fits.
    blocks.clear()
    print("MEMORYERROR", flush=True)
else:
    print("MEMORY_OK", flush=True)
