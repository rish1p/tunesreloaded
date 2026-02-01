#!/bin/bash

# TunesReloaded - WASM Build Script
# Compiles ipod_manager.c with libgpod and glib for WebAssembly

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== TunesReloaded WASM Build ===${NC}"

# Configuration - adjust these paths as needed
EMSDK_PATH="${HOME}/emsdk"
LIBGPOD_SRC="/Users/rishipadmanabhan/Documents/GitHub/libgpod-wasm/src"
LIBGPOD_LIB="${LIBGPOD_SRC}/.libs/libgpod.a"
MAMBA_ENV="/opt/homebrew/Cellar/micromamba/2.5.0/envs/libgpod-wasm-latest"

# Check if emsdk exists
if [ ! -d "$EMSDK_PATH" ]; then
    echo -e "${RED}Error: emsdk not found at $EMSDK_PATH${NC}"
    echo "Please set EMSDK_PATH to your emsdk installation"
    exit 1
fi

# Source emsdk
echo -e "${YELLOW}Sourcing emsdk...${NC}"
source "${EMSDK_PATH}/emsdk_env.sh" 2>/dev/null

# Check emcc
if ! command -v emcc &> /dev/null; then
    echo -e "${RED}Error: emcc not found. Is emsdk installed correctly?${NC}"
    exit 1
fi

echo -e "${GREEN}Using emcc: $(which emcc)${NC}"
emcc --version | head -1

# Check libgpod.a
if [ ! -f "$LIBGPOD_LIB" ]; then
    echo -e "${RED}Error: libgpod.a not found at $LIBGPOD_LIB${NC}"
    exit 1
fi
echo -e "${GREEN}Found libgpod.a${NC}"

# Check glib libraries
GLIB_LIB="${MAMBA_ENV}/lib/libglib-2.0.a"
if [ ! -f "$GLIB_LIB" ]; then
    echo -e "${RED}Error: libglib-2.0.a not found at $GLIB_LIB${NC}"
    exit 1
fi
echo -e "${GREEN}Found glib libraries${NC}"

# Include paths
INCLUDE_PATHS=(
    "-I${LIBGPOD_SRC}"
    "-I${MAMBA_ENV}/include"
    "-I${MAMBA_ENV}/include/glib-2.0"
    "-I${MAMBA_ENV}/lib/glib-2.0/include"
)

# Library paths
LIB_PATHS=(
    "-L${LIBGPOD_SRC}/.libs"
    "-L${MAMBA_ENV}/lib"
)

# Static libraries to link (order matters for static linking!)
LIBS=(
    "${LIBGPOD_LIB}"
    "${MAMBA_ENV}/lib/libplist-2.0.a"
    "${MAMBA_ENV}/lib/libglib-2.0.a"
    "${MAMBA_ENV}/lib/libgmodule-2.0.a"
    "${MAMBA_ENV}/lib/libgobject-2.0.a"
    "${MAMBA_ENV}/lib/libgthread-2.0.a"
    "${MAMBA_ENV}/lib/libgio-2.0.a"
    "${MAMBA_ENV}/lib/libiconv.a"
    "${MAMBA_ENV}/lib/libffi.a"
    "${MAMBA_ENV}/lib/libxml2.a"
    "${MAMBA_ENV}/lib/libz.a"
    "${MAMBA_ENV}/lib/libsqlite3.a"
)

# Thread stubs for single-threaded WASM
THREAD_STUBS="glib_thread_stubs.c"

# Compiler flags
CFLAGS=(
    "-O2"
    "-Wno-error"
    "-Wno-deprecated-declarations"
    "-Wno-cast-align"
    "-Wno-unused-but-set-variable"
    "-Wno-sometimes-uninitialized"
    "-Wno-implicit-function-declaration"
    "-Wno-int-conversion"
    "-DEMSCRIPTEN"
)

# Emscripten specific flags
EMFLAGS=(
    "-s" "WASM=1"
    "-s" "MODULARIZE=1"
    "-s" "EXPORT_NAME='createIPodModule'"
    "-s" "ALLOW_MEMORY_GROWTH=1"
    "-s" "INITIAL_MEMORY=67108864"     # 64MB initial
    "-s" "MAXIMUM_MEMORY=536870912"    # 512MB max
    "-s" "FORCE_FILESYSTEM=1"
    "-s" "EXPORTED_RUNTIME_METHODS=['FS','UTF8ToString','stringToUTF8','lengthBytesUTF8','ccall','cwrap']"
    "-s" "EXPORTED_FUNCTIONS=['_malloc','_free','_ipod_set_mountpoint','_ipod_get_mountpoint','_ipod_parse_db','_ipod_init_new','_ipod_write_db','_ipod_close_db','_ipod_is_db_loaded','_ipod_get_track_count','_ipod_get_track_json','_ipod_get_all_tracks_json','_ipod_free_string','_ipod_add_track','_ipod_track_set_path','_ipod_track_finalize','_ipod_finalize_last_track','_ipod_finalize_last_track_no_stat','_ipod_get_track_dest_path','_ipod_remove_track','_ipod_update_track','_ipod_get_playlist_count','_ipod_get_playlist_json','_ipod_get_all_playlists_json','_ipod_get_playlist_tracks_json','_ipod_create_playlist','_ipod_delete_playlist','_ipod_rename_playlist','_ipod_playlist_add_track','_ipod_playlist_remove_track','_ipod_path_to_ipod_format','_ipod_path_to_fs_format','_ipod_get_last_error','_ipod_clear_error','_ipod_get_device_info_json']"
    "-s" "NO_EXIT_RUNTIME=1"
    "-s" "ASYNCIFY=1"
    "-s" "EMULATE_FUNCTION_POINTER_CASTS=1"
    "--no-entry"
)

# Output files
OUTPUT_JS="ipod_manager.js"
OUTPUT_WASM="ipod_manager.wasm"

echo -e "${YELLOW}Compiling ipod_manager.c to WASM...${NC}"
echo ""

# Build command - include thread stubs before libraries
CMD="emcc ipod_manager.c ${THREAD_STUBS} ${CFLAGS[*]} ${INCLUDE_PATHS[*]} ${LIB_PATHS[*]} ${LIBS[*]} ${EMFLAGS[*]} -o ${OUTPUT_JS}"

echo "Build command:"
echo "$CMD"
echo ""

# Execute build
eval $CMD

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}=== Build Successful ===${NC}"
    echo -e "Output files:"
    echo -e "  - ${OUTPUT_JS}"
    echo -e "  - ${OUTPUT_WASM}"
    ls -lh ${OUTPUT_JS} ${OUTPUT_WASM} 2>/dev/null
    echo ""
    echo -e "${YELLOW}To serve locally:${NC}"
    echo "  python3 -m http.server 8080"
    echo "  Then open http://localhost:8080 in Chrome"
else
    echo -e "${RED}Build failed${NC}"
    exit 1
fi
