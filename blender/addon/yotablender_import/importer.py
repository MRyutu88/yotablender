# Builds Blender data from a YotaBlender project file (format versions 1-3).
# Kept free of operator code so scripts (and the repo's verify script) can call it directly:
#
#     from yotablender_import import importer
#     importer.import_project(bpy.context, importer.load_file(path), importer.Options())

import base64
import json
import os
import re
import tempfile
from dataclasses import dataclass, field

import bpy

FORMAT = "yotablender"
MAX_VERSION = 3
UV_MAP = "UVMap"
COLOR_ATTR = "Color"


class ImportError_(Exception):
    """A file this add-on can't read (shown to the user)."""


@dataclass
class Options:
    vertex_colors: str = "REPLACE"  # REPLACE | MULTIPLY | NONE
    new_collection: bool = True
    pack_images: bool = True
    # The project file, for saving unpacked textures next to it.
    source_path: str = ""


@dataclass
class Result:
    objects: list = field(default_factory=list)
    meshes: list = field(default_factory=list)
    materials: list = field(default_factory=list)
    images: list = field(default_factory=list)
    collection: object = None


def load_file(path):
    with open(path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            raise ImportError_(f"Not a YotaBlender project file ({e})")
    return migrate(data)


def migrate(data):
    """Brings older files up to the v3 layout."""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise ImportError_("Not a YotaBlender project file")
    version = data.get("version")
    if not isinstance(version, int):
        raise ImportError_("Project file has no version")
    if version > MAX_VERSION:
        raise ImportError_("This project was saved by a newer YotaBlender. Update the add-on.")
    for o in data.get("objects", []):
        if version < 2:
            mat = o.pop("material", None)
            o["materials"] = [mat] if mat else []
        mesh = o["mesh"]
        mesh.setdefault("loose_edges", [])
        mesh.setdefault("face_materials", [0] * len(mesh["faces"]))
        mesh.setdefault("color_attributes", [])
        mesh.setdefault("uv_layers", [])
        o.setdefault("texture", None)
        o.setdefault("modifiers", [])
    data.setdefault("images", [])
    data.setdefault("materials", [])
    return data


def import_project(context, data, options=None):
    opts = options or Options()
    data = migrate(data)
    result = Result()

    collection = context.collection
    if opts.new_collection:
        collection = bpy.data.collections.new(data["project"]["name"] or "YotaBlender")
        context.scene.collection.children.link(collection)
        result.collection = collection

    images = {}
    for im in data["images"]:
        img = _load_image(im, opts)
        if img:
            images[im["name"]] = img
            result.images.append(img)

    materials = _build_materials(data, images, opts, result)

    for o in data["objects"]:
        obj = _build_object(o, materials, collection)
        result.objects.append(obj)
        result.meshes.append(obj.data)

    # Select what was imported, like Blender's other importers.
    for ob in context.view_layer.objects:
        ob.select_set(False)
    for ob, o in zip(result.objects, data["objects"]):
        if o.get("visible", True):
            ob.select_set(True)
        else:
            ob.hide_set(True)
    if result.objects:
        context.view_layer.objects.active = result.objects[0]
    return result


# --- Objects -------------------------------------------------------------------------------


def _build_object(o, materials, collection):
    m = o["mesh"]
    me = bpy.data.meshes.new(o["name"])
    verts = [tuple(v) for v in m["vertices"]]
    faces = [tuple(f) for f in m["faces"]]
    edges = [tuple(e) for e in m["loose_edges"]]
    # Faces and corners keep their order, so per-face and per-corner data map 1:1.
    me.from_pydata(verts, edges, faces)

    slots = [materials[(name, _variant_key(o))] for name in o.get("materials", [])]
    for mat in slots:
        me.materials.append(mat)
    if slots and m["face_materials"]:
        top = len(slots) - 1
        me.polygons.foreach_set("material_index", [min(max(0, int(i)), top) for i in m["face_materials"]])

    for ca in m["color_attributes"]:
        if ca.get("domain") != "POINT" or len(ca["data"]) != len(verts):
            continue
        attr = me.color_attributes.new(ca.get("name") or COLOR_ATTR, "FLOAT_COLOR", "POINT")
        attr.data.foreach_set("color", [c for rgba in ca["data"] for c in rgba])
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = me.color_attributes.active_color_index

    has_uvs = False
    for uvl in m["uv_layers"]:
        if uvl.get("domain") != "CORNER" or len(uvl["data"]) != len(me.loops):
            continue
        layer = me.uv_layers.new(name=uvl.get("name") or UV_MAP)
        layer.uv.foreach_set("vector", [c for uv in uvl["data"] for c in uv])
        has_uvs = True

    mirror = o.get("use_mirror") or []
    for axis, on in zip("xyz", mirror):
        setattr(me, "use_mirror_" + axis, bool(on))

    if o.get("shade_smooth"):
        me.shade_smooth()
    else:
        me.shade_flat()
    me.update()

    obj = bpy.data.objects.new(o["name"], me)
    collection.objects.link(obj)
    obj.location = o["location"]
    obj.rotation_mode = o.get("rotation_mode", "XYZ")
    obj.rotation_euler = o["rotation_euler"]
    obj.scale = o["scale"]

    for md in o["modifiers"]:
        _add_modifier(obj, md, has_uvs)
    return obj


def _add_modifier(obj, md, has_uvs):
    kind = md.get("type")
    if kind == "MIRROR":
        mod = obj.modifiers.new(md.get("name") or "Mirror", "MIRROR")
        mod.use_axis = [bool(a) for a in md.get("use_axis", [True, False, False])]
        mod.use_clip = bool(md.get("use_clip", False))
        mod.use_mirror_merge = bool(md.get("use_mirror_merge", True))
        mod.merge_threshold = float(md.get("merge_threshold", 0.001))
    elif kind == "SUBSURF":
        mod = obj.modifiers.new(md.get("name") or "Subdivision", "SUBSURF")
        mod.levels = int(md.get("levels", 1))
        mod.render_levels = int(md.get("render_levels", 2))
        mod.use_limit_surface = bool(md.get("use_limit_surface", True))
        if has_uvs:
            # The app interpolates UVs linearly; this keeps the paint exactly where it was painted.
            mod.uv_smooth = "NONE"
        # drag_levels is app-only (preview level while a finger is down).
    else:
        return None
    mod.show_viewport = bool(md.get("show_viewport", True))
    return mod


# --- Materials -----------------------------------------------------------------------------


def _variant_key(o):
    """What a material needs to show for this object: vertex colors and/or its paint texture."""
    has_colors = any(ca.get("domain") == "POINT" for ca in o["mesh"]["color_attributes"])
    tex = o.get("texture")
    has_uvs = bool(o["mesh"]["uv_layers"])
    return (has_colors, tex["image"] if tex and has_uvs else None)


def _build_materials(data, images, opts, result):
    """One Blender material per (material, variant). A material that every user shows the same way
    keeps its name; objects that need something different (their own texture, or the Color
    attribute when others have none) get a copy named "<Material> (<Object>)"."""
    defs = {m["name"]: m for m in data["materials"]}
    users = {}  # material name -> {variant: [object names]}
    for o in data["objects"]:
        for name in o.get("materials", []):
            users.setdefault(name, {}).setdefault(_variant_key(o), []).append(o["name"])
    out = {}
    for name, variants in users.items():
        md = defs.get(name) or {"name": name, "base_color": [0.8, 0.8, 0.8, 1], "roughness": 0.5, "metallic": 0}
        # The variant used by most objects (plain first on ties) keeps the plain name.
        order = sorted(variants.items(), key=lambda kv: (-len(kv[1]), kv[0][0] or kv[0][1] is not None))
        for i, (variant, objs) in enumerate(order):
            has_colors, image = variant
            if i == 0:
                label = name
            elif image:
                label = f"{name} ({objs[0]})"
            else:
                label = f"{name} (Color)"
            colors = opts.vertex_colors if has_colors else "NONE"
            mat = _make_material(label, md, colors, images.get(image) if image else None)
            out[(name, variant)] = mat
            result.materials.append(mat)
    return out


def _make_material(label, md, vertex_colors, image):
    mat = bpy.data.materials.new(label)
    base = tuple(md.get("base_color", [0.8, 0.8, 0.8, 1]))
    rough = float(md.get("roughness", 0.5))
    metal = float(md.get("metallic", 0.0))
    # Solid-mode viewport display matches too.
    mat.diffuse_color = base
    mat.roughness = rough
    mat.metallic = metal
    if not mat.use_nodes:
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeOutputMaterial"), None) or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = base
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    x, y = bsdf.location.x, bsdf.location.y

    color_out = None  # socket feeding Base Color, if any
    if vertex_colors in ("REPLACE", "MULTIPLY"):
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = COLOR_ATTR
        attr.label = "Vertex Paint"
        attr.location = (x - 700, y - 60)
        color_out = attr.outputs["Color"]
        if vertex_colors == "MULTIPLY":
            mul = nt.nodes.new("ShaderNodeMix")
            mul.data_type = "RGBA"
            mul.blend_type = "MULTIPLY"
            mul.location = (x - 450, y - 40)
            mul.inputs["Factor"].default_value = 1.0
            _input(mul, "A_Color").default_value = base
            nt.links.new(color_out, _input(mul, "B_Color"))
            color_out = _output(mul, "Result_Color")

    if image is not None:
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.uv_map = UV_MAP
        uv.location = (x - 950, y + 260)
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.label = "Paint"
        tex.location = (x - 700, y + 300)
        nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MIX"
        mix.label = "Paint over color"
        mix.location = (x - 250, y + 120)
        nt.links.new(tex.outputs["Alpha"], _input(mix, "Factor_Float"))
        if color_out is not None:
            nt.links.new(color_out, _input(mix, "A_Color"))
        else:
            _input(mix, "A_Color").default_value = base
        nt.links.new(tex.outputs["Color"], _input(mix, "B_Color"))
        color_out = _output(mix, "Result_Color")

    if color_out is not None:
        nt.links.new(color_out, bsdf.inputs["Base Color"])
    return mat


def _input(node, identifier):
    return next(s for s in node.inputs if s.identifier == identifier)


def _output(node, identifier):
    return next(s for s in node.outputs if s.identifier == identifier)


# --- Images --------------------------------------------------------------------------------


def _safe(name):
    return re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip() or "texture"


def _load_image(im, opts):
    b64 = im.get("data")
    if not b64:
        return None
    raw = base64.b64decode(b64)
    fname = _safe(im["name"]) + ".png"
    if opts.pack_images or not opts.source_path:
        tmpdir = tempfile.mkdtemp(prefix="yotablender_")
        path = os.path.join(tmpdir, fname)
    else:
        path = os.path.join(os.path.dirname(os.path.abspath(opts.source_path)), fname)
        tmpdir = None
    with open(path, "wb") as f:
        f.write(raw)
    img = bpy.data.images.load(path)
    img.name = im["name"]
    img.colorspace_settings.name = "sRGB"
    img.alpha_mode = "STRAIGHT"
    if tmpdir:
        img.pack()
        # Where "Unpack" writes it: next to the .blend.
        img.filepath_raw = "//" + fname
        try:
            os.remove(path)
            os.rmdir(tmpdir)
        except OSError:
            pass
    return img
