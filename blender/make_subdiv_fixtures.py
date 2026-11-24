"""Generates golden Subdivision Surface results from Blender for YotaBlender's unit tests.

Run inside Blender (Scripting tab, or via the Blender MCP):
    exec(open(r"<repo>/blender/make_subdiv_fixtures.py").read())
Writes src/core/subdiv/fixtures/blender-subdiv.json next to this repo. Works in a temporary
scene that is removed afterwards, so the open file is not modified.
"""
import bpy, json, math, os

REPO = globals().get("YB_REPO") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "src", "core", "subdiv", "fixtures", "blender-subdiv.json")


def circle(i, n, r):
    a = i / n * math.pi * 2
    return (r * math.sin(a), r * math.cos(a))


def cases():
    cube_v = [(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    cube_f = [(0, 1, 3, 2), (2, 3, 7, 6), (6, 7, 5, 4), (4, 5, 1, 0), (2, 6, 4, 0), (7, 3, 1, 5)]
    yield "cube", cube_v, cube_f
    n = 8
    cyl_v, cyl_f = [], []
    for i in range(n):
        x, y = circle(i, n, 1)
        cyl_v += [(x, y, -1), (x, y, 1)]
    for i in range(n):
        j = (i + 1) % n
        cyl_f.append((2 * i, 2 * i + 1, 2 * j + 1, 2 * j))
    cyl_f.append(tuple(2 * ((n - i) % n) + 1 for i in range(n)))
    cyl_f.append(tuple(2 * i for i in range(n)))
    yield "cylinder8", cyl_v, cyl_f
    # Open 2x2 grid: boundary edges and valence-2 corners.
    grid_v = [(x, y, 0.3 * (x * y)) for y in (-1, 0, 1) for x in (-1, 0, 1)]
    grid_f = [(0, 1, 4, 3), (1, 2, 5, 4), (3, 4, 7, 6), (4, 5, 8, 7)]
    yield "grid2x2", grid_v, grid_f
    # Cone: triangles, an n-gon and a valence-6 apex.
    m = 6
    cone_v = [(*circle(i, m, 1), -1) for i in range(m)] + [(0, 0, 1)]
    cone_f = [(i, m, (i + 1) % m) for i in range(m)] + [tuple(range(m))]
    yield "cone6", cone_v, cone_f
    # Open box (cube without top): boundary loop on a closed-ish shape, mixed valences.
    box_f = [f for f in cube_f if f != (7, 3, 1, 5)]
    yield "openbox", cube_v, box_f


def run():
    out = []
    orig = bpy.context.window.scene
    scn = bpy.data.scenes.new("YB_fixture_tmp")
    bpy.context.window.scene = scn
    try:
        for name, verts, faces in cases():
            me = bpy.data.meshes.new("yb_" + name)
            me.from_pydata([tuple(map(float, v)) for v in verts], [], [tuple(f) for f in faces])
            me.update()
            ob = bpy.data.objects.new("yb_" + name, me)
            scn.collection.objects.link(ob)
            mod = ob.modifiers.new("Subdivision", "SUBSURF")
            for levels in (1, 2, 3):
                for limit in (True, False):
                    mod.levels = levels
                    mod.use_limit_surface = limit
                    dg = bpy.context.evaluated_depsgraph_get()
                    dg.update()
                    ev = ob.evaluated_get(dg)
                    em = ev.to_mesh()
                    out.append({
                        "name": name, "levels": levels, "limit": limit,
                        "input": {"positions": [c for v in verts for c in v], "faces": [list(f) for f in faces]},
                        "nv": len(em.vertices), "nf": len(em.polygons),
                        "positions": [round(c, 6) for v in em.vertices for c in v.co],
                    })
                    ev.to_mesh_clear()
            bpy.data.objects.remove(ob, do_unlink=True)
            bpy.data.meshes.remove(me)
    finally:
        bpy.context.window.scene = orig
        bpy.data.scenes.remove(scn)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump({"blender": bpy.app.version_string, "cases": out}, fh)
    return {"written": OUT, "cases": len(out), "blender": bpy.app.version_string}


result = run()
