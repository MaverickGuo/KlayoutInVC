#!/usr/bin/env python3
"""KLayout-backed lightweight HTTP service for GDS/OAS rendering."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, urlparse

try:
    import klayout.db as kdb
except Exception as exc:  # pragma: no cover - runtime dependency
    print("ERROR: 无法导入 klayout.db，请先安装 KLayout Python 包", file=sys.stderr)
    print(f"DETAIL: {exc}", file=sys.stderr)
    sys.exit(2)


@dataclass
class LayerEntry:
    index: int
    layer: int
    datatype: int
    name: str
    color: str


@dataclass
class TextEntry:
    x: int
    y: int
    text: str


class LayoutModel:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.layout = kdb.Layout()
        self.layout.read(file_path)
        self.dbu = float(get_value(self.layout, "dbu", 0.001))

        self.layer_entries = self._build_layer_entries()
        self.cell_name_to_index = self._build_cell_index_map()
        self.top_cell_names = self._get_top_cell_names()
        self.sorted_top_cell_names = sorted(self.top_cell_names, key=natural_sort_key)

        if not self.sorted_top_cell_names:
            raise RuntimeError("版图中未发现顶层 cell")

        self.default_cell_name = self.sorted_top_cell_names[0]
        self.default_bbox = self._cell_bbox(self.default_cell_name)
        self.cell_bboxes = {
            cell_name: self._cell_bbox(cell_name) for cell_name in self.sorted_top_cell_names
        }

        self._region_cache: "OrderedDict[Tuple[int, int], Optional[kdb.Region]]" = OrderedDict()
        self._text_cache: "OrderedDict[Tuple[int, int], List[TextEntry]]" = OrderedDict()
        self._render_svg_cache: "OrderedDict[Tuple, str]" = OrderedDict()
        self._region_cache_limit = 64
        self._text_cache_limit = 128
        self._render_svg_cache_limit = 40

    def _build_layer_entries(self) -> List[LayerEntry]:
        entries: List[LayerEntry] = []
        layer_count = int(get_value(self.layout, "layers", 0))

        for layer_index in range(layer_count):
            info = self.layout.get_info(layer_index)
            layer = int(get_value(info, "layer", 0))
            datatype = int(get_value(info, "datatype", 0))
            name = str(get_value(info, "name", ""))
            color = palette_color(layer_index)
            entries.append(
                LayerEntry(
                    index=layer_index,
                    layer=layer,
                    datatype=datatype,
                    name=name,
                    color=color,
                )
            )
        return entries

    def _build_cell_index_map(self) -> Dict[str, int]:
        name_to_index: Dict[str, int] = {}
        for cell in iter_cells(self.layout):
            name = str(get_value(cell, "name", ""))
            if not name:
                continue
            cell_index = int(get_value(cell, "cell_index", -1))
            if cell_index >= 0:
                name_to_index[name] = cell_index
        return name_to_index

    def _get_top_cell_names(self) -> List[str]:
        names: List[str] = []

        top_indexes: Sequence[int]
        if hasattr(self.layout, "top_cell_indexes"):
            top_indexes = list(self.layout.top_cell_indexes())
        else:
            top_indexes = []
            if hasattr(self.layout, "top_cells"):
                for cell in self.layout.top_cells():
                    top_indexes.append(int(get_value(cell, "cell_index", -1)))

        for cell_index in top_indexes:
            if cell_index < 0:
                continue
            cell = self.layout.cell(cell_index)
            name = str(get_value(cell, "name", ""))
            if name:
                names.append(name)

        return names

    def _cell_bbox(self, cell_name: str) -> List[int]:
        cell_index = self.cell_name_to_index.get(cell_name)
        if cell_index is None:
            return [0, 0, 1000, 1000]

        cell = self.layout.cell(cell_index)
        box = cell.bbox()
        return normalize_bbox(box_to_list(box))

    def to_metadata(self) -> dict:
        return {
            "file": self.file_path,
            "dbu": self.dbu,
            "bbox": self.default_bbox,
            "default_cell": self.default_cell_name,
            "top_cells": self.sorted_top_cell_names,
            "cell_bboxes": self.cell_bboxes,
            "layers": [
                {
                    "id": str(layer.index),
                    "layer": layer.layer,
                    "datatype": layer.datatype,
                    "name": layer.name,
                    "color": layer.color,
                }
                for layer in self.layer_entries
            ],
        }

    def render_svg(
        self,
        *,
        cell_name: str,
        x0: int,
        y0: int,
        x1: int,
        y1: int,
        width: int,
        height: int,
        hidden_layers: Sequence[str],
        max_polygons: int,
        show_labels: bool,
        max_labels: int,
        label_font_size: int,
        render_style: str,
    ) -> str:
        hidden = {str(item) for item in hidden_layers}
        width = max(1, width)
        height = max(1, height)
        label_font_size = max(6, min(int(label_font_size), 72))
        render_style = str(render_style or "hatch").strip().lower()
        if render_style not in {"hatch", "solid", "fast"}:
            render_style = "hatch"

        x0, y0, x1, y1 = normalize_bbox([x0, y0, x1, y1])
        view_width = max(1, x1 - x0)
        view_height = max(1, y1 - y0)

        scale_x = width / float(view_width)
        scale_y = height / float(view_height)
        visible_layers = [
            layer for layer in self.layer_entries if str(layer.index) not in hidden
        ]
        visible_layers.sort(key=lambda layer: (layer.layer, layer.datatype, layer.index))

        hidden_tuple = tuple(sorted(hidden))
        cache_key = self._render_cache_key(
            cell_name=cell_name,
            x0=x0,
            y0=y0,
            x1=x1,
            y1=y1,
            width=width,
            height=height,
            hidden_layers=hidden_tuple,
            show_labels=show_labels,
            max_polygons=max_polygons,
            max_labels=max_labels,
            label_font_size=label_font_size,
            render_style=render_style,
        )
        if cache_key in self._render_svg_cache:
            cached = self._render_svg_cache.pop(cache_key)
            self._render_svg_cache[cache_key] = cached
            return cached

        cell_index = self.cell_name_to_index.get(cell_name)
        if cell_index is None:
            cell_index = self.cell_name_to_index[self.default_cell_name]

        clip_region = kdb.Region(kdb.Box(x0, y0, x1, y1))
        pattern_id_map: Dict[int, str] = {}
        pattern_defs: List[str] = []
        if render_style == "hatch":
            for layer in visible_layers:
                pattern_id = f"layer_pat_{layer.index}"
                pattern_id_map[layer.index] = pattern_id
                pattern_defs.append(
                    make_hatch_pattern(
                        pattern_id,
                        layer.color,
                        layer_style_variant(layer),
                    )
                )

        parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        ]
        if pattern_defs:
            parts.append("<defs>")
            parts.extend(pattern_defs)
            parts.append("</defs>")
        polygon_count = 0
        label_count = 0

        for layer in visible_layers:
            region = self._get_region(cell_index, layer.index)
            if region is None:
                continue

            try:
                clipped_region = region & clip_region
            except Exception:
                clipped_region = region

            path_commands: List[str] = []
            for polygon in iter_region_polygons(clipped_region):
                points = polygon_points(polygon)
                if len(points) < 3:
                    continue

                screen_points: List[Tuple[float, float]] = []
                for px, py in points:
                    sx = (px - x0) * scale_x
                    sy = (y1 - py) * scale_y
                    screen_points.append((sx, sy))

                if len(screen_points) < 3:
                    continue

                path_commands.append(
                    "M "
                    + " L ".join(f"{sx:.2f} {sy:.2f}" for sx, sy in screen_points)
                    + " Z"
                    )
                polygon_count += 1

                if polygon_count >= max_polygons:
                    break

            if path_commands:
                path_d = " ".join(path_commands)
                if render_style == "hatch":
                    pattern_id = pattern_id_map.get(layer.index, "")
                    parts.append(
                        f'<path d="{path_d}" fill="{layer.color}" fill-opacity="0.02" stroke="none"/>'
                    )
                    if pattern_id:
                        parts.append(
                            f'<path d="{path_d}" fill="url(#{pattern_id})" fill-opacity="1" '
                            f'stroke="{layer.color}" stroke-opacity="0.9" stroke-width="0.85" '
                            'stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'
                        )
                    else:
                        parts.append(
                            f'<path d="{path_d}" fill="none" stroke="{layer.color}" '
                            'stroke-opacity="0.9" stroke-width="0.85" stroke-linejoin="round" '
                            'vector-effect="non-scaling-stroke"/>'
                        )
                elif render_style == "solid":
                    parts.append(
                        f'<path d="{path_d}" fill="{layer.color}" fill-opacity="0.10" '
                        f'stroke="{layer.color}" stroke-opacity="0.88" stroke-width="0.9" '
                        'stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'
                    )
                else:
                    parts.append(
                        f'<path d="{path_d}" fill="{layer.color}" fill-opacity="0.04" '
                        f'stroke="{layer.color}" stroke-opacity="0.76" stroke-width="0.72" stroke-linejoin="round" '
                        'vector-effect="non-scaling-stroke"/>'
                    )

            if polygon_count >= max_polygons:
                break

        if show_labels and max_labels > 0 and (scale_x >= 0.002 or scale_y >= 0.002):
            for layer in visible_layers:
                texts = self._get_text_items(cell_index, layer.index)
                if not texts:
                    continue

                for item in texts:
                    if item.x < x0 or item.x > x1 or item.y < y0 or item.y > y1:
                        continue

                    sx = (item.x - x0) * scale_x
                    sy = (y1 - item.y) * scale_y
                    if sx < -10 or sx > width + 10 or sy < -10 or sy > height + 10:
                        continue

                    text_value = xml_escape(item.text.strip())
                    if not text_value:
                        continue

                    parts.append(
                        f'<text x="{sx:.2f}" y="{sy:.2f}" fill="{layer.color}" fill-opacity="0.95" font-size="{label_font_size}" font-family="monospace">{text_value}</text>'
                    )
                    label_count += 1
                    if label_count >= max_labels:
                        break

                if label_count >= max_labels:
                    break

        parts.append("</svg>")
        svg = "".join(parts)
        put_lru(self._render_svg_cache, cache_key, svg, self._render_svg_cache_limit)
        return svg

    def snap_to_edge(
        self,
        *,
        cell_name: str,
        x: int,
        y: int,
        radius: int,
        hidden_layers: Sequence[str],
        max_scan_polygons: int,
    ) -> Optional[Tuple[int, int, float]]:
        hidden = set(hidden_layers)
        radius = max(1, int(radius))
        max_scan_polygons = max(500, int(max_scan_polygons))

        cell_index = self.cell_name_to_index.get(cell_name)
        if cell_index is None:
            cell_index = self.cell_name_to_index[self.default_cell_name]

        clip_box = kdb.Box(x - radius, y - radius, x + radius, y + radius)
        clip_region = kdb.Region(clip_box)

        best_x = 0.0
        best_y = 0.0
        best_d2 = float("inf")
        scanned_polygons = 0

        for layer in self.layer_entries:
            if str(layer.index) in hidden:
                continue

            region = self._get_region(cell_index, layer.index)
            if region is None:
                continue

            try:
                clipped_region = region & clip_region
            except Exception:
                clipped_region = region

            for polygon in iter_region_polygons(clipped_region):
                points = polygon_points(polygon)
                if len(points) < 2:
                    continue

                scanned_polygons += 1
                point_count = len(points)
                for i in range(point_count):
                    ax, ay = points[i]
                    bx, by = points[(i + 1) % point_count]
                    qx, qy, d2 = nearest_point_on_segment(
                        float(x),
                        float(y),
                        float(ax),
                        float(ay),
                        float(bx),
                        float(by),
                    )
                    if d2 < best_d2:
                        best_d2 = d2
                        best_x = qx
                        best_y = qy

                if scanned_polygons >= max_scan_polygons:
                    break

            if scanned_polygons >= max_scan_polygons:
                break

        if not math.isfinite(best_d2) or best_d2 > float(radius * radius):
            return None

        return int(round(best_x)), int(round(best_y)), math.sqrt(best_d2)

    def _get_region(self, cell_index: int, layer_index: int) -> Optional[kdb.Region]:
        cache_key = (cell_index, layer_index)
        if cache_key in self._region_cache:
            region = self._region_cache.pop(cache_key)
            self._region_cache[cache_key] = region
            return region

        cell = self.layout.cell(cell_index)
        region: Optional[kdb.Region]

        try:
            region = kdb.Region(cell.begin_shapes_rec(layer_index))
        except Exception:
            region = None

        put_lru(self._region_cache, cache_key, region, self._region_cache_limit)
        return region

    def _get_text_items(self, cell_index: int, layer_index: int) -> List[TextEntry]:
        cache_key = (cell_index, layer_index)
        if cache_key in self._text_cache:
            items = self._text_cache.pop(cache_key)
            self._text_cache[cache_key] = items
            return items

        cell = self.layout.cell(cell_index)
        items: List[TextEntry] = []

        try:
            iterator = cell.begin_shapes_rec(layer_index)
        except Exception:
            iterator = None

        if iterator is not None:
            while not iterator.at_end():
                shape = iterator.shape()
                if shape.is_text():
                    text_string = extract_text_string(shape)
                    if text_string:
                        tx, ty = extract_text_position(shape, iterator)
                        items.append(TextEntry(x=tx, y=ty, text=text_string))
                iterator.next()

        put_lru(self._text_cache, cache_key, items, self._text_cache_limit)
        return items

    def _render_cache_key(
        self,
        *,
        cell_name: str,
        x0: int,
        y0: int,
        x1: int,
        y1: int,
        width: int,
        height: int,
        hidden_layers: Tuple[str, ...],
        show_labels: bool,
        max_polygons: int,
        max_labels: int,
        label_font_size: int,
        render_style: str,
    ) -> Tuple:
        view_w = max(1, x1 - x0)
        view_h = max(1, y1 - y0)
        # Quantize view to absorb tiny pan/zoom jitter and improve cache hit rate.
        quantum = max(1, int(max(view_w / max(width, 1), view_h / max(height, 1)) * 1.6))

        return (
            cell_name,
            quantize_int(x0, quantum),
            quantize_int(y0, quantum),
            quantize_int(x1, quantum),
            quantize_int(y1, quantum),
            int(width),
            int(height),
            hidden_layers,
            1 if show_labels else 0,
            int(max_polygons),
            int(max_labels),
            int(label_font_size),
            str(render_style),
            quantum,
        )


class ServerActivity:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last_touch = time.monotonic()

    def touch(self) -> None:
        with self._lock:
            self._last_touch = time.monotonic()

    def seconds_since_touch(self) -> float:
        with self._lock:
            return time.monotonic() - self._last_touch


def make_handler(layout_model: LayoutModel, token: str, activity: ServerActivity):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler requires this name
            activity.touch()
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)

            if not token_valid(query, self.headers, token):
                self.send_json({"error": "unauthorized"}, status=HTTPStatus.FORBIDDEN)
                return

            if parsed.path == "/health":
                self.send_json({"ok": True})
                return

            if parsed.path == "/meta":
                self.send_json(layout_model.to_metadata())
                return

            if parsed.path == "/snap":
                try:
                    cell = str(get_query(query, "cell", layout_model.default_cell_name))
                    x = int(get_query(query, "x", 0))
                    y = int(get_query(query, "y", 0))
                    radius = int(get_query(query, "radius", 2000))
                    hidden = split_csv(str(get_query(query, "hidden_layers", "")))
                    max_scan_polygons = int(get_query(query, "max_scan_polygons", 12000))

                    snap = layout_model.snap_to_edge(
                        cell_name=cell,
                        x=x,
                        y=y,
                        radius=max(1, min(radius, 2_000_000)),
                        hidden_layers=hidden,
                        max_scan_polygons=max(500, min(max_scan_polygons, 100_000)),
                    )
                except Exception as exc:
                    self.send_json(
                        {
                            "error": "snap_failed",
                            "detail": str(exc),
                        },
                        status=HTTPStatus.INTERNAL_SERVER_ERROR,
                    )
                    return

                if snap is None:
                    self.send_json({"snapped": False})
                else:
                    sx, sy, distance = snap
                    self.send_json(
                        {
                            "snapped": True,
                            "x": sx,
                            "y": sy,
                            "distance": distance,
                        }
                    )
                return

            if parsed.path == "/render.svg":
                try:
                    cell = str(get_query(query, "cell", layout_model.default_cell_name))
                    x0 = int(get_query(query, "x0", layout_model.default_bbox[0]))
                    y0 = int(get_query(query, "y0", layout_model.default_bbox[1]))
                    x1 = int(get_query(query, "x1", layout_model.default_bbox[2]))
                    y1 = int(get_query(query, "y1", layout_model.default_bbox[3]))
                    width = int(get_query(query, "width", 1600))
                    height = int(get_query(query, "height", 900))
                    hidden = split_csv(str(get_query(query, "hidden_layers", "")))
                    max_polygons = int(get_query(query, "max_polygons", 45000))
                    show_labels = str(get_query(query, "show_labels", "1")).strip() not in {"0", "false", "False"}
                    max_labels = int(get_query(query, "max_labels", 12000))
                    label_font_size = int(get_query(query, "label_font_size", 13))
                    render_style = str(get_query(query, "render_style", "hatch")).strip().lower()

                    svg = layout_model.render_svg(
                        cell_name=cell,
                        x0=x0,
                        y0=y0,
                        x1=x1,
                        y1=y1,
                        width=width,
                        height=height,
                        hidden_layers=hidden,
                        max_polygons=max(1000, min(max_polygons, 150000)),
                        show_labels=show_labels,
                        max_labels=max(500, min(max_labels, 30000)),
                        label_font_size=max(6, min(label_font_size, 72)),
                        render_style=render_style,
                    )
                except Exception as exc:
                    self.send_json(
                        {
                            "error": "render_failed",
                            "detail": str(exc),
                        },
                        status=HTTPStatus.INTERNAL_SERVER_ERROR,
                    )
                    return

                data = svg.encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self._send_common_headers()
                self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

            self.send_json({"error": "not_found"}, status=HTTPStatus.NOT_FOUND)

        def log_message(self, fmt: str, *args) -> None:  # noqa: A003
            return

        def send_json(self, payload: dict, *, status: HTTPStatus = HTTPStatus.OK) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._send_common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_common_headers(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")

    return Handler


def token_valid(query: dict, headers, expected: str) -> bool:
    query_token = str(get_query(query, "token", ""))
    header_token = headers.get("x-gds-token", "")
    return query_token == expected or header_token == expected


def get_query(query: dict, key: str, default):
    values = query.get(key)
    if not values:
        return default
    return values[0]


def put_lru(cache: OrderedDict, key, value, limit: int) -> None:
    cache[key] = value
    while len(cache) > limit:
        cache.popitem(last=False)


def quantize_int(value: int, quantum: int) -> int:
    if quantum <= 1:
        return int(value)
    return int(round(float(value) / float(quantum))) * int(quantum)


def extract_text_string(shape) -> str:
    if hasattr(shape, "text_string"):
        raw = get_value(shape, "text_string", "")
        text = str(raw).strip()
        if text:
            return text

    text_obj = get_value(shape, "text", None)
    if text_obj is None:
        return ""

    raw = get_value(text_obj, "string", "")
    return str(raw).strip()


def extract_text_position(shape, iterator) -> Tuple[int, int]:
    text_obj = get_value(shape, "text", None)
    local_trans = get_value(text_obj, "trans", None) if text_obj is not None else None
    if local_trans is None:
        local_trans = kdb.Trans()

    iter_trans = kdb.Trans()
    if hasattr(iterator, "trans"):
        maybe_trans = get_value(iterator, "trans", None)
        if maybe_trans is not None:
            iter_trans = maybe_trans

    try:
        global_trans = iter_trans * local_trans
        disp = get_value(global_trans, "disp", None)
        if disp is not None:
            return int(get_value(disp, "x", 0)), int(get_value(disp, "y", 0))
    except Exception:
        pass

    if text_obj is not None:
        return int(get_value(text_obj, "x", 0)), int(get_value(text_obj, "y", 0))

    return 0, 0


def iter_cells(layout: kdb.Layout) -> Iterable:
    if hasattr(layout, "each_cell"):
        yield from layout.each_cell()
        return

    cell_count = int(get_value(layout, "cells", 0))
    for idx in range(cell_count):
        yield layout.cell(idx)


def iter_region_polygons(region: kdb.Region) -> Iterable:
    if hasattr(region, "each"):
        yield from region.each()
        return

    try:
        yield from region
    except TypeError:
        return


def polygon_points(polygon) -> List[Tuple[int, int]]:
    points: List[Tuple[int, int]] = []

    if hasattr(polygon, "to_simple_polygon"):
        try:
            polygon = polygon.to_simple_polygon()
        except Exception:
            pass

    iterators = ["each_point_hull", "each_point"]
    for iterator_name in iterators:
        if not hasattr(polygon, iterator_name):
            continue

        iterator = getattr(polygon, iterator_name)
        point_iter = iterator() if callable(iterator) else iterator
        for point in point_iter:
            x = int(get_value(point, "x", 0))
            y = int(get_value(point, "y", 0))
            points.append((x, y))
        if points:
            return points

    return points


def nearest_point_on_segment(
    px: float,
    py: float,
    ax: float,
    ay: float,
    bx: float,
    by: float,
) -> Tuple[float, float, float]:
    vx = bx - ax
    vy = by - ay
    denom = vx * vx + vy * vy
    if denom <= 0.0:
        qx, qy = ax, ay
    else:
        t = ((px - ax) * vx + (py - ay) * vy) / denom
        t = max(0.0, min(1.0, t))
        qx = ax + t * vx
        qy = ay + t * vy

    dx = qx - px
    dy = qy - py
    return qx, qy, dx * dx + dy * dy


def get_value(obj, name: str, default):
    value = getattr(obj, name, None)
    if value is None:
        return default
    if callable(value):
        try:
            return value()
        except TypeError:
            return default
    return value


def box_to_list(box) -> List[int]:
    if box is None:
        return [0, 0, 1000, 1000]

    left = int(get_value(box, "left", 0))
    right = int(get_value(box, "right", 0))
    bottom = int(get_value(box, "bottom", 0))
    top = int(get_value(box, "top", 0))
    return [left, bottom, right, top]


def normalize_bbox(bbox: Sequence[int]) -> List[int]:
    x0, y0, x1, y1 = [int(v) for v in bbox]
    if x1 <= x0:
        x1 = x0 + 1
    if y1 <= y0:
        y1 = y0 + 1
    return [x0, y0, x1, y1]


def split_csv(text: str) -> List[str]:
    return [item.strip() for item in text.split(",") if item.strip()]


def natural_sort_key(text: str) -> Tuple:
    parts = re.split(r"([0-9]+)", text or "")
    key: List[Tuple[int, object]] = []
    for part in parts:
        if part.isdigit():
            key.append((0, int(part)))
        else:
            key.append((1, part.lower()))
    return tuple(key)


def layer_style_variant(layer: LayerEntry) -> int:
    # Stable mapping: same (layer, datatype) always gets the same hatch style.
    key = (int(layer.layer) * 131) ^ (int(layer.datatype) * 17) ^ int(layer.index)
    return key % 12


def make_hatch_pattern(pattern_id: str, color: str, variant: int) -> str:
    variant = int(variant) % 12
    width = 8
    height = 8
    stroke_width = 0.7
    stroke_opacity = 0.46
    path_defs: List[str] = []
    dots: List[Tuple[float, float, float]] = []

    if variant == 0:
        path_defs = ["M 0 8 L 8 0"]
    elif variant == 1:
        path_defs = ["M 0 0 L 8 8"]
    elif variant == 2:
        path_defs = ["M 0 2 L 8 2", "M 0 6 L 8 6"]
    elif variant == 3:
        path_defs = ["M 2 0 L 2 8", "M 6 0 L 6 8"]
    elif variant == 4:
        path_defs = ["M 0 8 L 8 0", "M 0 0 L 8 8"]
    elif variant == 5:
        width = 10
        height = 10
        path_defs = ["M 0 0 L 10 0", "M 0 5 L 10 5"]
    elif variant == 6:
        width = 10
        height = 10
        path_defs = ["M 0 0 L 0 10", "M 5 0 L 5 10"]
    elif variant == 7:
        width = 10
        height = 10
        path_defs = ["M 0 10 L 10 0", "M -5 5 L 5 -5", "M 5 15 L 15 5"]
    elif variant == 8:
        width = 10
        height = 10
        path_defs = ["M 0 0 L 10 10", "M -5 5 L 5 15", "M 5 -5 L 15 5"]
    elif variant == 9:
        width = 12
        height = 12
        stroke_width = 0.65
        path_defs = ["M 0 3 L 12 3", "M 0 9 L 12 9", "M 3 0 L 3 12", "M 9 0 L 9 12"]
    elif variant == 10:
        width = 10
        height = 10
        stroke_opacity = 0.5
        dots = [(2.0, 2.0, 0.8), (7.0, 7.0, 0.8)]
    else:
        width = 12
        height = 12
        stroke_width = 0.65
        path_defs = ["M 0 6 L 12 6", "M 6 0 L 6 12", "M 0 0 L 12 12"]

    parts = [
        f'<pattern id="{pattern_id}" patternUnits="userSpaceOnUse" width="{width}" height="{height}">'
    ]
    for path_d in path_defs:
        parts.append(
            f'<path d="{path_d}" fill="none" stroke="{color}" stroke-opacity="{stroke_opacity:.3f}" '
            f'stroke-width="{stroke_width}" vector-effect="non-scaling-stroke"/>'
        )
    for cx, cy, r in dots:
        parts.append(
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}" fill-opacity="{stroke_opacity:.3f}"/>'
        )
    parts.append("</pattern>")
    return "".join(parts)


def xml_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('\"', "&quot;")
        .replace("'", "&apos;")
    )


def palette_color(index: int) -> str:
    hue = (index * 47) % 360
    sat = 58 + (index * 17) % 24
    val = 62 + (index * 9) % 28
    return hsv_to_hex(hue / 360.0, sat / 100.0, val / 100.0)


def hsv_to_hex(h: float, s: float, v: float) -> str:
    if s <= 0.0:
        r = g = b = int(v * 255)
        return f"#{r:02x}{g:02x}{b:02x}"

    h = (h % 1.0) * 6.0
    i = int(math.floor(h))
    f = h - i
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))

    if i == 0:
        r, g, b = v, t, p
    elif i == 1:
        r, g, b = q, v, p
    elif i == 2:
        r, g, b = p, v, t
    elif i == 3:
        r, g, b = p, q, v
    elif i == 4:
        r, g, b = t, p, v
    else:
        r, g, b = v, p, q

    return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="KLayout GDS render backend")
    parser.add_argument("--file", required=True, help="GDS/OAS file path")
    parser.add_argument("--host", default="127.0.0.1", help="bind host")
    parser.add_argument("--port", type=int, default=0, help="bind port, 0 for random")
    parser.add_argument("--token", required=True, help="auth token")
    parser.add_argument(
        "--idle-timeout-sec",
        type=int,
        default=900,
        help="服务空闲自动退出时间（秒）",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    model = LayoutModel(args.file)
    activity = ServerActivity()
    handler_cls = make_handler(model, args.token, activity)

    server = ThreadingHTTPServer((args.host, args.port), handler_cls)
    print(f"READY port={server.server_port}", flush=True)

    idle_timeout_sec = max(60, int(args.idle_timeout_sec))

    def watchdog() -> None:
        while True:
            time.sleep(5)
            if activity.seconds_since_touch() > idle_timeout_sec:
                try:
                    server.shutdown()
                except Exception:
                    pass
                return

    threading.Thread(target=watchdog, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
