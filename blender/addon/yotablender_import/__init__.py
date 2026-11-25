# YotaBlender Importer: File > Import > YotaBlender (.yblend.json).
#
# Rebuilds every object of a YotaBlender project: the exact cage (quads, n-gons, loose edges),
# the transform, shade smooth, the Mirror -> Subdivision Surface stack with the same settings,
# Principled BSDF materials with per-face assignment, the "Color" attribute from Vertex Paint,
# and the UV map plus paint texture from Texture Paint.

import bpy
from bpy.props import BoolProperty, EnumProperty, StringProperty
from bpy_extras.io_utils import ImportHelper

from . import importer


class IMPORT_SCENE_OT_yotablender(bpy.types.Operator, ImportHelper):
    """Import a YotaBlender project (.yblend.json)"""

    bl_idname = "import_scene.yotablender"
    bl_label = "Import YotaBlender"
    bl_options = {"REGISTER", "UNDO", "PRESET"}

    filename_ext = ".json"
    filter_glob: StringProperty(default="*.yblend.json;*.json", options={"HIDDEN"})

    vertex_colors: EnumProperty(
        name="Vertex Colors",
        description="How the painted Color attribute feeds the materials",
        items=(
            ("REPLACE", "Replace Base Color", "Show the Color attribute instead of the base color, like the app"),
            ("MULTIPLY", "Multiply", "Multiply the base color by the Color attribute"),
            ("NONE", "Don't Use", "Keep the attribute on the mesh, but leave the materials alone"),
        ),
        default="REPLACE",
    )
    new_collection: BoolProperty(
        name="New Collection",
        description="Put the imported objects into a new collection named after the project",
        default=True,
    )
    pack_images: BoolProperty(
        name="Pack Textures",
        description="Pack paint textures into the .blend file (otherwise they are saved as PNG next to the project file)",
        default=True,
    )

    def execute(self, context):
        try:
            data = importer.load_file(self.filepath)
            result = importer.import_project(
                context,
                data,
                importer.Options(
                    vertex_colors=self.vertex_colors,
                    new_collection=self.new_collection,
                    pack_images=self.pack_images,
                    source_path=self.filepath,
                ),
            )
        except importer.ImportError_ as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        self.report({"INFO"}, f"Imported {len(result.objects)} object(s) from {data['project']['name']}")
        return {"FINISHED"}


def menu_func_import(self, context):
    self.layout.operator(IMPORT_SCENE_OT_yotablender.bl_idname, text="YotaBlender (.yblend.json)")


def register():
    bpy.utils.register_class(IMPORT_SCENE_OT_yotablender)
    bpy.types.TOPBAR_MT_file_import.append(menu_func_import)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_func_import)
    bpy.utils.unregister_class(IMPORT_SCENE_OT_yotablender)
