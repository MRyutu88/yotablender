"""Imports YotaBlender's sample OBJ exports into Blender and checks that topology survived.

Run inside Blender (Scripting tab: open this file and press Run, or exec() it via the MCP).
It works in a temporary scene that is deleted afterwards, so your open file is untouched.

Checks, per object: name, vertex count, face count, and the histogram of face sizes
(3 = triangles, 4 = quads, 8 = the cylinder's n-gon caps…), plus one vertex position to
confirm the Z-up/Y-up conversion and baked transforms.
"""
import bpy, json, os
from collections import Counter

REPO = globals().get("YB_REPO") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(REPO, "blender", "samples")


def import_and_count(path):
    before = set(bpy.data.objects)
    bpy.ops.wm.obj_import(filepath=path)  # Blender defaults: forward -Z, up Y
    new = [o for o in bpy.data.objects if o not in before]
    out = {}
    for o in new:
        me = o.data
        sizes = Counter(len(p.vertices) for p in me.polygons)
        out[o.name] = {
            "verts": len(me.vertices),
            "faces": len(me.polygons),
            "sizes": {str(k): v for k, v in sorted(sizes.items())},
            "first_vertex_world": [round(c, 5) for c in (o.matrix_world @ me.vertices[0].co)],
            "materials": [m.name for m in me.materials if m],
        }
    return out, new


def run():
    expected = json.load(open(os.path.join(SAMPLES, "expected-counts.json")))
    orig = bpy.context.window.scene
    scn = bpy.data.scenes.new("YB_verify_tmp")
    bpy.context.window.scene = scn
    report = {"blender": bpy.app.version_string, "ok": True, "files": {}}
    try:
        for key, fname in (("cage", "yotablender-sample.obj"), ("mirrored", "yotablender-sample-mirrored.obj")):
            got, objs = import_and_count(os.path.join(SAMPLES, fname))
            try:
                checks = []
                for exp in expected[key]:
                    g = got.get(exp["name"])
                    ok = bool(g) and g["verts"] == exp["verts"] and g["faces"] == exp["faces"] and g["sizes"] == exp["sizes"]
                    report["ok"] &= ok
                    checks.append({"name": exp["name"], "ok": ok, "expected": exp, "got": g})
                report["files"][fname] = checks
            finally:
                cleanup(objs)  # before the next import, so names don't get ".001" suffixes
    finally:
        bpy.context.window.scene = orig
        bpy.data.scenes.remove(scn)
    return report


def cleanup(objs):
    mats = set()
    for o in objs:
        me = o.data
        mats.update(m for m in me.materials if m)
        bpy.data.objects.remove(o, do_unlink=True)
        if me.users == 0:
            bpy.data.meshes.remove(me)
    for m in mats:
        if m.users == 0:
            bpy.data.materials.remove(m)


result = run()
