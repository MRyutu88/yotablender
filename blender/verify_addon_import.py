"""Imports blender/samples/yotablender-sample.yblend.json with the YotaBlender add-on and checks
everything against blender/samples/expected-addon.json (written by the app's tests):

- cage: vertex/face/loose-edge counts and the histogram of face sizes
- transform, shade smooth
- modifiers in order with their settings (Subdivision UV Smooth = None on objects with UVs)
- the evaluated result: vertex/face/corner counts, the sum of all vertex positions and the sum of
  all corner UVs, compared with the app's own Mirror -> Subdivision evaluation
- materials (base color, roughness, metallic) and per-face assignment
- the "Color" attribute, the UV map, the paint texture (size, packed, sampled pixels) and its
  node wiring

Run inside Blender (Scripting tab, or exec() it via the MCP). By default the add-on is loaded
from this repo without installing it; set YB_USE_OPERATOR = True to go through the installed
File > Import operator instead. Everything happens in a temporary scene that is deleted
afterwards, together with every datablock the import created.
"""
import bpy, importlib.util, json, math, os, re, sys
from collections import Counter

REPO = globals().get("YB_REPO") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(REPO, "blender", "samples")
SAMPLE = os.path.join(SAMPLES, "yotablender-sample.yblend.json")
USE_OPERATOR = globals().get("YB_USE_OPERATOR", False)


def load_importer():
    path = os.path.join(REPO, "blender", "addon", "yotablender_import", "importer.py")
    spec = importlib.util.spec_from_file_location("yb_importer_dev", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def close(a, b, tol=1e-4):
    if isinstance(a, (list, tuple)):
        return len(a) == len(b) and all(close(x, y, tol) for x, y in zip(a, b))
    return abs(a - b) <= tol * max(1.0, abs(b))


def base_name(n):
    return re.sub(r"( \(.*\))?(\.\d{3})?$", "", n)


def check_object(ob, exp, images):
    me = ob.data
    out = []

    def check(what, ok, got=None, want=None):
        out.append({"check": what, "ok": bool(ok), **({} if ok else {"got": got, "want": want})})

    face_edges = set()
    for p in me.polygons:
        vs = list(p.vertices)
        for i in range(len(vs)):
            face_edges.add(frozenset((vs[i], vs[(i + 1) % len(vs)])))
    loose = sum(1 for e in me.edges if frozenset(e.vertices) not in face_edges)
    sizes = {str(k): v for k, v in sorted(Counter(len(p.vertices) for p in me.polygons).items())}
    check("vertex count", len(me.vertices) == exp["verts"], len(me.vertices), exp["verts"])
    check("face count", len(me.polygons) == exp["faces"], len(me.polygons), exp["faces"])
    check("face sizes", sizes == exp["sizes"], sizes, exp["sizes"])
    check("loose edges", loose == exp["loose_edges"], loose, exp["loose_edges"])
    check("location", close(list(ob.location), exp["location"]), list(ob.location), exp["location"])
    check("rotation", ob.rotation_mode == "XYZ" and close(list(ob.rotation_euler), exp["rotation_euler"]), list(ob.rotation_euler), exp["rotation_euler"])
    check("scale", close(list(ob.scale), exp["scale"]), list(ob.scale), exp["scale"])
    sharp = me.attributes.get("sharp_face")
    smooth = not (sharp and any(v.value for v in sharp.data))
    check("shade smooth", smooth == exp["shade_smooth"], smooth, exp["shade_smooth"])

    # Modifiers, in order, with every setting the app stores.
    mods = []
    for m in ob.modifiers:
        if m.type == "MIRROR":
            mods.append({"type": "MIRROR", "name": m.name, "show_viewport": m.show_viewport, "use_axis": list(m.use_axis),
                         "use_clip": m.use_clip, "use_mirror_merge": m.use_mirror_merge, "merge_threshold": round(m.merge_threshold, 6)})
        elif m.type == "SUBSURF":
            mods.append({"type": "SUBSURF", "name": m.name, "show_viewport": m.show_viewport, "levels": m.levels,
                         "render_levels": m.render_levels, "use_limit_surface": m.use_limit_surface})
    want_mods = [{**m, **({"merge_threshold": round(m["merge_threshold"], 6)} if "merge_threshold" in m else {})} for m in exp["modifiers"]]
    check("modifiers", mods == want_mods, mods, want_mods)
    has_uv = exp["uv_corners"] > 0
    for m in ob.modifiers:
        if m.type == "SUBSURF":
            want = "NONE" if has_uv else m.uv_smooth
            check("subsurf uv_smooth", m.uv_smooth == want, m.uv_smooth, want)

    # Evaluated mesh vs the app's own evaluation.
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    em = ev.to_mesh()
    try:
        corners = len(em.loops)
        psum = [0.0, 0.0, 0.0]
        for v in em.vertices:
            for k in range(3):
                psum[k] += v.co[k]
        e = exp["evaluated"]
        got = {"verts": len(em.vertices), "faces": len(em.polygons), "corners": corners}
        want = {"verts": e["verts"], "faces": e["faces"], "corners": e["corners"]}
        check("evaluated counts", got == want, got, want)
        check("evaluated position sum", close(psum, e["position_sum"], 1e-3), psum, e["position_sum"])
        if e["uv_sum"] is not None:
            uvl = em.uv_layers.get("UVMap")
            usum = [0.0, 0.0]
            if uvl:
                for d in uvl.uv:
                    usum[0] += d.vector[0]
                    usum[1] += d.vector[1]
            check("evaluated UV sum", uvl is not None and close(usum, e["uv_sum"], 1e-4), usum, e["uv_sum"])
    finally:
        ev.to_mesh_clear()

    # Materials per slot and per face.
    slots = [{"name": base_name(m.name), "base_color": [round(c, 5) for c in m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value],
              "roughness": round(m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value, 5),
              "metallic": round(m.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value, 5)} for m in me.materials]
    want_slots = [{"name": m["name"], "base_color": [round(c, 5) for c in m["base_color"]], "roughness": round(m["roughness"], 5),
                   "metallic": round(m["metallic"], 5)} for m in exp["materials"]]
    check("material slots", slots == want_slots, slots, want_slots)
    fm = dict(Counter(base_name(me.materials[p.material_index].name) for p in me.polygons)) if me.materials else {}
    check("face materials", fm == exp["face_materials"], fm, exp["face_materials"])

    # Vertex paint.
    ca = me.color_attributes.get("Color")
    if exp["colors"]:
        ok = bool(ca) and ca.domain == "POINT" and ca.data_type == "FLOAT_COLOR"
        got = None
        if ok:
            got = {"first": [round(c, 5) for c in ca.data[0].color], "last": [round(c, 5) for c in ca.data[len(ca.data) - 1].color]}
            want = {"first": [round(c, 5) for c in exp["colors"]["first"]], "last": [round(c, 5) for c in exp["colors"]["last"]]}
            ok = got == want
        check("color attribute", ok, got, exp["colors"])
        # Wired into the material: a Color Attribute node reading "Color".
        wired = all(any(n.bl_idname == "ShaderNodeVertexColor" and n.layer_name == "Color" for n in m.node_tree.nodes) for m in me.materials)
        check("color attribute in material", wired)
    else:
        check("no color attribute", ca is None)

    # UVs and texture.
    uvl = me.uv_layers.get("UVMap")
    if has_uv:
        check("UV corners", uvl is not None and len(uvl.uv) == exp["uv_corners"], len(uvl.uv) if uvl else None, exp["uv_corners"])
        if uvl:
            first = [c for i in me.polygons[0].loop_indices for c in uvl.uv[i].vector]
            check("UVs of face 0", close(first, exp["uv_first_face"], 1e-5), first, exp["uv_first_face"])
    else:
        check("no UV map", uvl is None)
    if exp["texture"]:
        img = images.get(exp["texture"])
        check("texture image exists", img is not None, None, exp["texture"])
        for m in me.materials:
            nodes = m.node_tree.nodes
            tex = [n for n in nodes if n.bl_idname == "ShaderNodeTexImage"]
            ok = len(tex) == 1 and tex[0].image == img
            bsdf = nodes["Principled BSDF"]
            link = bsdf.inputs["Base Color"].links[0] if bsdf.inputs["Base Color"].links else None
            mix = link.from_node if link else None
            ok = ok and mix is not None and mix.bl_idname == "ShaderNodeMix" and mix.blend_type == "MIX"
            if ok:
                fac = next(s for s in mix.inputs if s.identifier == "Factor_Float")
                b = next(s for s in mix.inputs if s.identifier == "B_Color")
                ok = fac.links and fac.links[0].from_socket.name == "Alpha" and b.links and b.links[0].from_node == tex[0]
                uvn = tex[0].inputs["Vector"].links[0].from_node if tex[0].inputs["Vector"].links else None
                ok = ok and uvn is not None and uvn.bl_idname == "ShaderNodeUVMap" and uvn.uv_map == "UVMap"
            check(f"paint wiring in {m.name}", ok)
    return out


def check_images(images, exp_images):
    out = []
    for e in exp_images:
        img = images.get(e["name"])
        if not img:
            out.append({"check": f"image {e['name']}", "ok": False})
            continue
        w, h = img.size
        px = img.pixels[:]
        samples = []
        ok = [w, h] == e["size"] and img.packed_file is not None and img.colorspace_settings.name == "sRGB" and img.alpha_mode == "STRAIGHT"
        for s in e["samples"]:
            i = (s["y"] * w + s["x"]) * 4
            got = [round(px[i + k] * 255) for k in range(4)]
            # Fully transparent texels: only alpha matters.
            good = got == s["rgba"] if s["rgba"][3] else got[3] == 0
            ok = ok and good
            samples.append({"xy": [s["x"], s["y"]], "got": got, "want": s["rgba"]})
        out.append({"check": f"image {e['name']}", "ok": ok, "size": [w, h], "packed": img.packed_file is not None, "samples": samples})
    return out


def run():
    expected = json.load(open(os.path.join(SAMPLES, "expected-addon.json")))
    orig = bpy.context.window.scene
    before = {k: set(getattr(bpy.data, k)) for k in ("objects", "meshes", "materials", "images", "collections")}
    scn = bpy.data.scenes.new("YB_addon_verify_tmp")
    bpy.context.window.scene = scn
    report = {"blender": bpy.app.version_string, "via": "operator" if USE_OPERATOR else "repo importer", "ok": True, "objects": {}}
    try:
        if USE_OPERATOR:
            bpy.ops.import_scene.yotablender(filepath=SAMPLE)
        else:
            imp = load_importer()
            imp.import_project(bpy.context, imp.load_file(SAMPLE), imp.Options())
        new_objects = [o for o in bpy.data.objects if o not in before["objects"]]
        new_images = {i.name: i for i in bpy.data.images if i not in before["images"]}
        by_name = {o.name: o for o in new_objects}
        for exp in expected["objects"]:
            ob = by_name.get(exp["name"])
            checks = check_object(ob, exp, new_images) if ob else [{"check": "object exists", "ok": False}]
            ok = all(c["ok"] for c in checks)
            report["ok"] &= ok
            report["objects"][exp["name"]] = {"ok": ok, "failed": [c for c in checks if not c["ok"]], "checks": len(checks)}
        img_checks = check_images(new_images, expected["images"])
        report["images"] = img_checks
        report["ok"] &= all(c["ok"] for c in img_checks)
        report["materials"] = sorted(m.name for m in bpy.data.materials if m not in before["materials"])
        cols = [c for c in bpy.data.collections if c not in before["collections"]]
        report["collection"] = [c.name for c in cols]
    finally:
        bpy.context.window.scene = orig
        # Remove everything the import created, then the scene.
        for kind in ("objects", "meshes", "materials", "images", "collections"):
            coll = getattr(bpy.data, kind)
            for d in [d for d in coll if d not in before[kind]]:
                coll.remove(d)
        bpy.data.scenes.remove(scn)
    return report


if __name__ == "__main__" or "result" not in globals():
    result = run()
    print(json.dumps(result, indent=1))
