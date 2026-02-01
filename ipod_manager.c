/*
 * ipod_manager.c - Track upload and playlist management for TunesReloaded
 *
 * WebAssembly bindings for libgpod functionality.
 * Compiled with Emscripten to interface with Chrome File System Access API.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <time.h>
#include <ctype.h>
#include <emscripten.h>
#include "itdb.h"
#include "itdb_device.h"

/* Global database pointer */
static Itdb_iTunesDB *g_itdb = NULL;
static char g_mountpoint[4096] = "";
static char g_last_error[1024] = "";
static Itdb_Track *g_last_added_track = NULL;  /* Track pointer for finalization */

/* ============================================================================
 * Utility Functions
 * ============================================================================ */

static void set_error(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vsnprintf(g_last_error, sizeof(g_last_error), fmt, args);
    va_end(args);
    printf("[ERROR] %s\n", g_last_error);
}

static void log_info(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char buf[1024];
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    printf("[INFO] %s\n", buf);
}

/* Helper: Validate and sanitize UTF-8 string
 * Returns a newly allocated string (caller must free) or NULL on error
 * Invalid UTF-8 sequences are stripped
 */
static char* sanitize_utf8_string(const char *str) {
    if (!str) return NULL;
    
    const gchar *end = NULL;
    if (!g_utf8_validate(str, -1, &end)) {
        if (end && end > str) {
            gsize bytes_read = end - str;
            gchar *safe = g_malloc(bytes_read + 1);
            memcpy(safe, str, bytes_read);
            safe[bytes_read] = '\0';
            return safe;
        }
        return g_strdup("");
    }
    return g_strdup(str);
}

/* Helper: Sanitize a string field if invalid UTF-8
 * Replaces the field pointer if sanitization is needed
 */
static void sanitize_field_if_needed(char **field_ptr, const char *field_name, guint32 track_id) {
    if (!field_ptr || !*field_ptr) return;
    
    if (!g_utf8_validate(*field_ptr, -1, NULL)) {
        log_info("Warning: Track %u has invalid UTF-8 in %s, sanitizing", track_id, field_name);
        char *old = *field_ptr;
        *field_ptr = sanitize_utf8_string(old);
        g_free(old);
    }
}

/* Helper: Escape JSON string into buffer
 * Returns number of characters written (excluding null terminator)
 */
static int escape_json_string(char *dest, const char *src, size_t max_len) {
    if (!src || !dest || max_len < 1) {
        if (dest && max_len > 0) dest[0] = '\0';
        return 0;
    }
    
    char *dst = dest;
    const char *s = src;
    size_t remaining = max_len - 1;
    
    while (*s && remaining > 0) {
        if (*s == '"' || *s == '\\') {
            if (remaining < 2) break;
            *dst++ = '\\';
            *dst++ = *s++;
            remaining -= 2;
        } else if (*s == '\n') {
            if (remaining < 2) break;
            *dst++ = '\\';
            *dst++ = 'n';
            s++;
            remaining -= 2;
        } else if (*s == '\r') {
            if (remaining < 2) break;
            *dst++ = '\\';
            *dst++ = 'r';
            s++;
            remaining -= 2;
        } else {
            *dst++ = *s++;
            remaining--;
        }
    }
    *dst = '\0';
    return dst - dest;
}

/* ============================================================================
 * Debug Functions
 * ============================================================================ */

/**
 * Log detailed device info for debugging iPod model detection issues
 */
static void log_device_info(Itdb_iTunesDB *itdb) {
    if (!itdb || !itdb->device) {
        printf("[DEBUG] Device info: No device attached to database\n");
        return;
    }
    
    Itdb_Device *device = itdb->device;
    
    printf("[DEBUG] ====== iPod Device Information ======\n");
    
    /* Get iPod info struct */
    const Itdb_IpodInfo *info = itdb_device_get_ipod_info(device);
    if (info) {
        const gchar *model_name = itdb_info_get_ipod_model_name_string(info->ipod_model);
        const gchar *gen_name = itdb_info_get_ipod_generation_string(info->ipod_generation);
        printf("[DEBUG] Model Name: %s\n", model_name ? model_name : "(unknown)");
        printf("[DEBUG] Generation Name: %s\n", gen_name ? gen_name : "(unknown)");
        printf("[DEBUG] Model Number: %s\n", info->model_number ? info->model_number : "(null)");
        printf("[DEBUG] Generation (enum): %d\n", info->ipod_generation);
        printf("[DEBUG] Capacity (GB): %.1f\n", info->capacity);
        printf("[DEBUG] iPod Model (enum): %d\n", info->ipod_model);
    } else {
        printf("[DEBUG] iPod Info: NULL (device not recognized)\n");
    }
    
    /* Get SysInfo values */
    const gchar *firewire_guid = itdb_device_get_sysinfo(device, "FirewireGuid");
    const gchar *serial_number = itdb_device_get_sysinfo(device, "SerialNumber");
    const gchar *model_num_str = itdb_device_get_sysinfo(device, "ModelNumStr");
    const gchar *board_type = itdb_device_get_sysinfo(device, "BoardType");
    const gchar *build_id = itdb_device_get_sysinfo(device, "BuildID");
    const gchar *visual_name = itdb_device_get_sysinfo(device, "VisibleBuildID");
    
    printf("[DEBUG] SysInfo FirewireGuid: %s\n", firewire_guid ? firewire_guid : "(not set)");
    printf("[DEBUG] SysInfo SerialNumber: %s\n", serial_number ? serial_number : "(not set)");
    printf("[DEBUG] SysInfo ModelNumStr: %s\n", model_num_str ? model_num_str : "(not set)");
    printf("[DEBUG] SysInfo BoardType: %s\n", board_type ? board_type : "(not set)");
    printf("[DEBUG] SysInfo BuildID: %s\n", build_id ? build_id : "(not set)");
    printf("[DEBUG] SysInfo VisibleBuildID: %s\n", visual_name ? visual_name : "(not set)");
    
    /* Check if device supports artwork (correlates with newer models) */
    gboolean supports_artwork = itdb_device_supports_artwork(device);
    printf("[DEBUG] Supports Artwork: %s\n", supports_artwork ? "yes" : "no");

    /* For iPod Classic 6G+: libgpod requires writing a device-specific hash.
     * This is driven by checksum type + a derived FirewireId (from SysInfo FirewireGuid). */
    ItdbChecksumType checksum_type = itdb_device_get_checksum_type(device);
    printf("[DEBUG] Checksum Type: %d\n", (int)checksum_type);

    const char *firewire_id = itdb_device_get_firewire_id(device);
    printf("[DEBUG] FirewireId: %s\n", firewire_id ? firewire_id : "(null)");

    if (checksum_type != ITDB_CHECKSUM_NONE && (!firewire_id || firewire_id[0] == '\0')) {
        printf("[DEBUG] WARNING: Checksum required but FirewireId is 0 (SysInfo FirewireGuid likely missing/invalid)\n");
    }
    
    printf("[DEBUG] ==========================================\n");
}

/**
 * Get device info as JSON string (caller must free)
 * Useful for debugging from JavaScript
 */
EMSCRIPTEN_KEEPALIVE
char* ipod_get_device_info_json(void) {
    static char buffer[4096];
    
    if (!g_itdb || !g_itdb->device) {
        snprintf(buffer, sizeof(buffer), "{\"error\": \"No device loaded\"}");
        return buffer;
    }
    
    Itdb_Device *device = g_itdb->device;
    const Itdb_IpodInfo *info = itdb_device_get_ipod_info(device);
    
    const gchar *firewire_guid = itdb_device_get_sysinfo(device, "FirewireGuid");
    const gchar *serial_number = itdb_device_get_sysinfo(device, "SerialNumber");
    const gchar *model_num_str = itdb_device_get_sysinfo(device, "ModelNumStr");
    const gchar *board_type = itdb_device_get_sysinfo(device, "BoardType");

    ItdbChecksumType checksum_type = itdb_device_get_checksum_type(device);
    const char *firewire_id = itdb_device_get_firewire_id(device);
    
    char model_name_escaped[256] = "";
    char gen_name_escaped[128] = "";
    char model_number_escaped[64] = "";
    char firewire_escaped[128] = "";
    char firewire_id_escaped[128] = "";
    char serial_escaped[128] = "";
    char model_str_escaped[64] = "";
    char board_escaped[64] = "";
    
    if (info) {
        const gchar *model_name = itdb_info_get_ipod_model_name_string(info->ipod_model);
        const gchar *gen_name = itdb_info_get_ipod_generation_string(info->ipod_generation);
        if (model_name) escape_json_string(model_name_escaped, model_name, sizeof(model_name_escaped));
        if (gen_name) escape_json_string(gen_name_escaped, gen_name, sizeof(gen_name_escaped));
        if (info->model_number) escape_json_string(model_number_escaped, info->model_number, sizeof(model_number_escaped));
    }
    if (firewire_guid) escape_json_string(firewire_escaped, firewire_guid, sizeof(firewire_escaped));
    if (firewire_id) escape_json_string(firewire_id_escaped, firewire_id, sizeof(firewire_id_escaped));
    if (serial_number) escape_json_string(serial_escaped, serial_number, sizeof(serial_escaped));
    if (model_num_str) escape_json_string(model_str_escaped, model_num_str, sizeof(model_str_escaped));
    if (board_type) escape_json_string(board_escaped, board_type, sizeof(board_escaped));
    
    snprintf(buffer, sizeof(buffer),
        "{"
        "\"model_name\": \"%s\","
        "\"generation_name\": \"%s\","
        "\"model_number\": \"%s\","
        "\"generation\": %d,"
        "\"capacity_gb\": %.1f,"
        "\"ipod_model\": %d,"
        "\"firewire_guid\": \"%s\","
        "\"firewire_id\": \"%s\","
        "\"checksum_type\": %d,"
        "\"serial_number\": \"%s\","
        "\"model_num_str\": \"%s\","
        "\"board_type\": \"%s\","
        "\"device_recognized\": %s"
        "}",
        model_name_escaped,
        gen_name_escaped,
        model_number_escaped,
        info ? info->ipod_generation : -1,
        info ? info->capacity : 0.0,
        info ? info->ipod_model : -1,
        firewire_escaped,
        firewire_id_escaped,
        (int)checksum_type,
        serial_escaped,
        model_str_escaped,
        board_escaped,
        (info && info->ipod_generation > 0) ? "true" : "false"
    );
    
    return buffer;
}

/* ============================================================================
 * Database Functions
 * ============================================================================ */

/**
 * Get the last error message
 */
EMSCRIPTEN_KEEPALIVE
const char* ipod_get_last_error(void) {
    return g_last_error;
}

/**
 * Clear the last error
 */
EMSCRIPTEN_KEEPALIVE
void ipod_clear_error(void) {
    g_last_error[0] = '\0';
}

/**
 * Set the mountpoint path for the iPod
 * Also sets it on the database if it exists
 */
EMSCRIPTEN_KEEPALIVE
int ipod_set_mountpoint(const char *mountpoint) {
    if (!mountpoint || strlen(mountpoint) == 0) {
        set_error("Mountpoint cannot be empty");
        return -1;
    }
    strncpy(g_mountpoint, mountpoint, sizeof(g_mountpoint) - 1);
    g_mountpoint[sizeof(g_mountpoint) - 1] = '\0';
    
    // Also set mountpoint on database if it exists
    if (g_itdb) {
        itdb_set_mountpoint(g_itdb, g_mountpoint);
    }
    
    log_info("Mountpoint set to: %s", g_mountpoint);
    return 0;
}

/**
 * Get the current mountpoint
 */
EMSCRIPTEN_KEEPALIVE
const char* ipod_get_mountpoint(void) {
    return g_mountpoint;
}

/**
 * Parse/load an existing iTunesDB from the iPod
 */
EMSCRIPTEN_KEEPALIVE
int ipod_parse_db(void) {
    GError *error = NULL;

    if (strlen(g_mountpoint) == 0) {
        set_error("Mountpoint not set. Call ipod_set_mountpoint first.");
        return -1;
    }

    /* Free existing database if any */
    if (g_itdb) {
        itdb_free(g_itdb);
        g_itdb = NULL;
    }

    log_info("Parsing iTunesDB from: %s", g_mountpoint);
    g_itdb = itdb_parse(g_mountpoint, &error);

    if (!g_itdb) {
        if (error) {
            set_error("Failed to parse iTunesDB: %s", error->message);
            g_error_free(error);
        } else {
            set_error("Failed to parse iTunesDB: Unknown error");
        }
        return -1;
    }

    // Set mountpoint on the database
    itdb_set_mountpoint(g_itdb, g_mountpoint);
    
    // Read SysInfo to populate device information (model, generation, etc.)
    if (g_itdb->device) {
        if (itdb_device_read_sysinfo(g_itdb->device)) {
            log_info("Successfully read SysInfo");
        } else {
            log_info("Warning: Could not read SysInfo (device info may be incomplete)");
        }
    }
    
    log_info("Successfully parsed iTunesDB. Tracks: %u, Playlists: %u",
             itdb_tracks_number(g_itdb), itdb_playlists_number(g_itdb));
    
    // Debug: Log device info to help diagnose model detection issues
    log_device_info(g_itdb);
    
    return 0;
}

/**
 * Initialize a new iPod database
 */
EMSCRIPTEN_KEEPALIVE
int ipod_init_new(const char *model_number, const char *ipod_name) {
    GError *error = NULL;

    if (strlen(g_mountpoint) == 0) {
        set_error("Mountpoint not set. Call ipod_set_mountpoint first.");
        return -1;
    }

    if (!model_number) model_number = "MA450"; /* Default to iPod Classic 80GB */
    if (!ipod_name) ipod_name = "iPod";

    log_info("Initializing new iPod: model=%s, name=%s", model_number, ipod_name);

    if (!itdb_init_ipod(g_mountpoint, model_number, ipod_name, &error)) {
        if (error) {
            set_error("Failed to initialize iPod: %s", error->message);
            g_error_free(error);
        } else {
            set_error("Failed to initialize iPod: Unknown error");
        }
        return -1;
    }

    /* Now parse the newly created database */
    return ipod_parse_db();
}

/**
 * Write/save the iTunesDB back to the iPod
 */
EMSCRIPTEN_KEEPALIVE
int ipod_write_db(void) {
    GError *error = NULL;

    if (!g_itdb) {
        set_error("No database loaded. Call ipod_parse_db first.");
        return -1;
    }

    // Ensure mountpoint is set on the database before writing
    // This is required for proper database structure validation
    if (strlen(g_mountpoint) > 0) {
        itdb_set_mountpoint(g_itdb, g_mountpoint);
    }

    // Validate database structure before writing
    // Check that all tracks and playlists have valid UTF-8 strings
    GList *tracks = g_itdb->tracks;
    for (GList *l = tracks; l != NULL; l = l->next) {
        Itdb_Track *track = (Itdb_Track *)l->data;
        if (!track) continue;
        
        // Validate UTF-8 in ALL string fields that libgpod might validate
        sanitize_field_if_needed(&track->title, "title", track->id);
        sanitize_field_if_needed(&track->artist, "artist", track->id);
        sanitize_field_if_needed(&track->album, "album", track->id);
        sanitize_field_if_needed(&track->genre, "genre", track->id);
        sanitize_field_if_needed(&track->filetype, "filetype", track->id);
        sanitize_field_if_needed(&track->ipod_path, "ipod_path", track->id);
    }
    
    // Validate playlist names and ensure all playlist members point to valid tracks
    GList *playlists = g_itdb->playlists;
    for (GList *l = playlists; l != NULL; l = l->next) {
        Itdb_Playlist *pl = (Itdb_Playlist *)l->data;
        if (!pl) continue;
        
        if (pl->name && !g_utf8_validate(pl->name, -1, NULL)) {
            log_info("Warning: Playlist has invalid UTF-8 in name, sanitizing");
            char *old_name = pl->name;
            pl->name = sanitize_utf8_string(old_name);
            g_free(old_name);
        }
        
        // Validate that all playlist members point to tracks that exist in the database
        // This prevents "link" assertion failures
        GList *valid_tracks = g_itdb->tracks;
        GList *members = pl->members;
        GList *to_remove = NULL;
        
        // First pass: identify invalid members (collect track pointers, not list nodes)
        for (GList *m = members; m != NULL; m = m->next) {
            Itdb_Track *member_track = (Itdb_Track *)m->data;
            if (!member_track) {
                // NULL track pointer - collect the list node for removal
                to_remove = g_list_prepend(to_remove, m);
                log_info("Warning: Playlist %s has NULL track pointer", pl->name ? pl->name : "Unknown");
                continue;
            }
            // Check if track exists in database by searching the tracks list
            gboolean found = FALSE;
            for (GList *t = valid_tracks; t != NULL; t = t->next) {
                if (t->data == member_track) {
                    found = TRUE;
                    break;
                }
            }
            if (!found) {
                // Track not in database - collect the list node for removal
                to_remove = g_list_prepend(to_remove, m);
                log_info("Warning: Playlist %s references invalid track %u", 
                         pl->name ? pl->name : "Unknown", member_track->id);
            }
        }
        
        // Second pass: remove invalid members directly from playlist members list
        for (GList *rm = to_remove; rm != NULL; rm = rm->next) {
            GList *member_node = (GList *)rm->data;
            if (member_node) {
                pl->members = g_list_remove_link(pl->members, member_node);
                g_list_free_1(member_node);  // Free just this node, not the track
            }
        }
        g_list_free(to_remove);
    }

    log_info("Writing iTunesDB...");
    
    // Disable smart playlists to prevent validation issues
    for (GList *l = g_itdb->playlists; l != NULL; l = l->next) {
        Itdb_Playlist *pl = (Itdb_Playlist *)l->data;
        if (pl && pl->is_spl) {
            pl->is_spl = FALSE;
        }
    }

    if (!itdb_write(g_itdb, &error)) {
        if (error) {
            set_error("Failed to write iTunesDB: %s", error->message);
            g_error_free(error);
        } else {
            set_error("Failed to write iTunesDB: Unknown error");
        }
        return -1;
    }

    log_info("Successfully wrote iTunesDB");
    return 0;
}

/**
 * Close and free the database
 */
EMSCRIPTEN_KEEPALIVE
void ipod_close_db(void) {
    if (g_itdb) {
        itdb_free(g_itdb);
        g_itdb = NULL;
        log_info("Database closed");
    }
}

/**
 * Check if database is loaded
 */
EMSCRIPTEN_KEEPALIVE
int ipod_is_db_loaded(void) {
    return g_itdb != NULL ? 1 : 0;
}

/* ============================================================================
 * Track Listing Functions
 * ============================================================================ */

/**
 * Get total number of tracks
 */
EMSCRIPTEN_KEEPALIVE
int ipod_get_track_count(void) {
    if (!g_itdb) return 0;
    return (int)itdb_tracks_number(g_itdb);
}

/**
 * Get track info as JSON string (caller must free)
 * Returns NULL on error
 */
EMSCRIPTEN_KEEPALIVE
char* ipod_get_track_json(int index) {
    if (!g_itdb) {
        set_error("No database loaded");
        return NULL;
    }

    GList *tracks = g_itdb->tracks;
    Itdb_Track *track = (Itdb_Track *)g_list_nth_data(tracks, index);

    if (!track) {
        set_error("Track index %d out of range", index);
        return NULL;
    }

    /* Build JSON string - escape special characters */
    char *json = (char *)malloc(8192);
    if (!json) return NULL;

    char title_esc[512] = "", artist_esc[512] = "", album_esc[512] = "";
    char genre_esc[256] = "", path_esc[1024] = "";

    escape_json_string(title_esc, track->title, sizeof(title_esc));
    escape_json_string(artist_esc, track->artist, sizeof(artist_esc));
    escape_json_string(album_esc, track->album, sizeof(album_esc));
    escape_json_string(genre_esc, track->genre, sizeof(genre_esc));
    escape_json_string(path_esc, track->ipod_path, sizeof(path_esc));

    /* NOTE: "id" is the track INDEX in the list, not track->id
     * This is because track->id is 0 for newly added tracks until itdb_write() */
    snprintf(json, 8192,
        "{"
        "\"id\":%d,"
        "\"dbid\":%llu,"
        "\"title\":\"%s\","
        "\"artist\":\"%s\","
        "\"album\":\"%s\","
        "\"genre\":\"%s\","
        "\"track_nr\":%d,"
        "\"cd_nr\":%d,"
        "\"year\":%d,"
        "\"tracklen\":%d,"
        "\"bitrate\":%d,"
        "\"samplerate\":%u,"
        "\"size\":%d,"
        "\"playcount\":%u,"
        "\"rating\":%u,"
        "\"ipod_path\":\"%s\","
        "\"transferred\":%s"
        "}",
        index,  /* Use index instead of track->id */
        (unsigned long long)track->dbid,
        title_esc,
        artist_esc,
        album_esc,
        genre_esc,
        track->track_nr,
        track->cd_nr,
        track->year,
        track->tracklen,
        track->bitrate,
        track->samplerate,
        track->size,
        track->playcount,
        track->rating,
        path_esc,
        track->transferred ? "true" : "false"
    );

    return json;
}

/**
 * Get all tracks as JSON array (caller must free)
 */
EMSCRIPTEN_KEEPALIVE
char* ipod_get_all_tracks_json(void) {
    if (!g_itdb) {
        set_error("No database loaded");
        return NULL;
    }

    int count = ipod_get_track_count();

    /* Estimate size: ~1KB per track */
    size_t buf_size = count * 1024 + 256;
    char *json = (char *)malloc(buf_size);
    if (!json) return NULL;

    strcpy(json, "[");
    size_t pos = 1;

    for (int i = 0; i < count; i++) {
        char *track_json = ipod_get_track_json(i);
        if (track_json) {
            size_t track_len = strlen(track_json);

            /* Grow buffer if needed */
            if (pos + track_len + 10 > buf_size) {
                buf_size *= 2;
                char *new_buf = realloc(json, buf_size);
                if (!new_buf) {
                    free(json);
                    free(track_json);
                    return NULL;
                }
                json = new_buf;
            }

            if (i > 0) json[pos++] = ',';
            memcpy(json + pos, track_json, track_len);
            pos += track_len;
            free(track_json);
        }
    }

    json[pos++] = ']';
    json[pos] = '\0';

    return json;
}

/**
 * Free a string allocated by the library
 */
EMSCRIPTEN_KEEPALIVE
void ipod_free_string(char *str) {
    if (str) free(str);
}

/* ============================================================================
 * Track Management Functions
 * ============================================================================ */

/**
 * Create a new track and add it to the database
 * Returns track ID on success, -1 on error
 */
EMSCRIPTEN_KEEPALIVE
int ipod_add_track(
    const char *title,
    const char *artist,
    const char *album,
    const char *genre,
    int track_nr,
    int cd_nr,
    int year,
    int tracklen_ms,
    int bitrate,
    int samplerate,
    int size_bytes,
    const char *filetype
) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    Itdb_Track *track = itdb_track_new();
    if (!track) {
        set_error("Failed to create new track");
        return -1;
    }

    /* Set metadata - validate UTF-8 to prevent assertion failures */
    if (title) {
        track->title = sanitize_utf8_string(title);
    }
    if (artist) {
        track->artist = sanitize_utf8_string(artist);
    }
    if (album) {
        track->album = sanitize_utf8_string(album);
    }
    if (genre) {
        track->genre = sanitize_utf8_string(genre);
    }
    if (filetype) {
        track->filetype = sanitize_utf8_string(filetype);
    }

    track->track_nr = track_nr;
    track->cd_nr = cd_nr;
    track->year = year;
    track->tracklen = tracklen_ms;
    track->bitrate = bitrate;
    track->samplerate = samplerate;
    track->size = size_bytes;

    /* Set timestamps */
    track->time_added = time(NULL);
    track->time_modified = track->time_added;

    /* Set media type to audio */
    track->mediatype = ITDB_MEDIATYPE_AUDIO;

    /* Mark as not yet transferred */
    track->transferred = FALSE;

    /* Add to database (at end) */
    itdb_track_add(g_itdb, track, -1);

    /* Also add to master playlist (if not already present) */
    Itdb_Playlist *mpl = itdb_playlist_mpl(g_itdb);
    if (mpl && !itdb_playlist_contains_track(mpl, track)) {
        itdb_playlist_add_track(mpl, track, -1);
    }

    /* Store pointer for finalization (IDs are not assigned until write) */
    g_last_added_track = track;

    /* Return track position in list (since ID is always 0 until write) */
    int track_index = g_list_index(g_itdb->tracks, track);
    
    log_info("Added track: %s - %s (index: %d)",
             artist ? artist : "Unknown",
             title ? title : "Unknown",
             track_index);

    return track_index;
}

/**
 * Finalize track after file is copied using libgpod's proper function
 * This sets ipod_path, filetype_marker, transferred, and size
 * @track_index: index of track in the tracks list (NOT the track ID!)
 * @dest_filename: filesystem path (with slashes), not iPod path (with colons)
 * 
 * NOTE: Track IDs are 0 until itdb_write() is called. Use track_index instead.
 */
EMSCRIPTEN_KEEPALIVE
int ipod_track_finalize(int track_index, const char *dest_filename) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    /* Use track index to find the track (IDs are not assigned until write) */
    Itdb_Track *track = (Itdb_Track *)g_list_nth_data(g_itdb->tracks, (guint)track_index);
    if (!track) {
        set_error("Track not found at index: %d", track_index);
        return -1;
    }

    GError *error = NULL;
    
    // Use libgpod's proper function to finalize the track
    // This sets ipod_path (converts from FS to iPod format), filetype_marker, transferred, size
    // Pass g_mountpoint (not NULL) so libgpod can properly resolve paths
    Itdb_Track *finalized = itdb_cp_finalize(track, g_mountpoint, dest_filename, &error);
    
    if (!finalized) {
        if (error) {
            set_error("Failed to finalize track: %s", error->message);
            g_error_free(error);
        } else {
            set_error("Failed to finalize track: Unknown error");
        }
        return -1;
    }

    log_info("Finalized track index %d: %s", track_index, track->ipod_path ? track->ipod_path : "NULL");
    return 0;
}

/**
 * Finalize the most recently added track
 * This is the preferred method - uses the stored track pointer directly
 */
EMSCRIPTEN_KEEPALIVE
int ipod_finalize_last_track(const char *dest_filename) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    if (!g_last_added_track) {
        set_error("No track has been added yet");
        return -1;
    }

    GError *error = NULL;
    Itdb_Track *finalized = itdb_cp_finalize(g_last_added_track, g_mountpoint, dest_filename, &error);
    
    if (!finalized) {
        if (error) {
            set_error("Failed to finalize track: %s", error->message);
            g_error_free(error);
        } else {
            set_error("Failed to finalize track: Unknown error");
        }
        return -1;
    }

    log_info("Finalized last track: %s", g_last_added_track->ipod_path ? g_last_added_track->ipod_path : "NULL");
    return 0;
}

/**
 * Finalize the most recently added track WITHOUT stat() or file access.
 *
 * This is used when the audio file is written directly to the real iPod
 * filesystem by JavaScript, and therefore does not exist in MEMFS.
 *
 * Sets:
 * - track->ipod_path (colon format, relative to mountpoint)
 * - track->filetype_marker (derived from filename suffix)
 * - track->transferred = TRUE
 * - track->size (from size_bytes)
 */
EMSCRIPTEN_KEEPALIVE
int ipod_finalize_last_track_no_stat(const char *dest_filename, int size_bytes) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    if (!g_last_added_track) {
        set_error("No track has been added yet");
        return -1;
    }

    if (!dest_filename || strlen(g_mountpoint) == 0) {
        set_error("No destination filename or mountpoint");
        return -1;
    }

    /* Ensure dest_filename is under mountpoint */
    size_t mplen = strlen(g_mountpoint);
    if (strlen(dest_filename) < mplen || strncmp(dest_filename, g_mountpoint, mplen) != 0) {
        set_error("Destination file is not under mountpoint");
        return -1;
    }

    Itdb_Track *track = g_last_added_track;

    /* Update transferred + size */
    track->transferred = TRUE;
    if (size_bytes > 0) {
        track->size = size_bytes;
    }

    /* Derive ipod_path exactly like itdb_cp_finalize() does:
     * - strip mountpoint, ensure it begins with '/'
     * - convert from FS path to iPod path via itdb_filename_fs2ipod()
     */
    g_free(track->ipod_path);
    track->ipod_path = NULL;

    if ((int)strlen(g_mountpoint) >= (int)strlen(dest_filename)) {
        set_error("Destination file does not appear to be on the iPod mounted at mountpoint");
        return -1;
    }

    if (dest_filename[mplen] == G_DIR_SEPARATOR) {
        track->ipod_path = g_strdup(&dest_filename[mplen]);
    } else {
        track->ipod_path = g_strdup_printf("%c%s", G_DIR_SEPARATOR, &dest_filename[mplen]);
    }

    if (!track->ipod_path) {
        set_error("Failed to allocate ipod_path");
        return -1;
    }

    itdb_filename_fs2ipod(track->ipod_path);

    /* Derive filetype_marker from suffix, like libgpod's itdb_cp_finalize */
    const char *suffix = strrchr(dest_filename, '.');
    if (!suffix) suffix = ".";

    guint32 marker = 0;
    for (int i = 1; i <= 4; i++) { /* skip '.' */
        marker = marker << 8;
        if ((int)strlen(suffix) > i) {
            marker |= (guint8)toupper((unsigned char)suffix[i]);
        } else {
            marker |= (guint8)' ';
        }
    }
    track->filetype_marker = marker;

    log_info("Finalized last track (no-stat): %s", track->ipod_path ? track->ipod_path : "NULL");
    return 0;
}

/**
 * Set the iPod path for a track (legacy function - use ipod_track_finalize instead)
 * @track_index: index of track in the tracks list (NOT the track ID!)
 * Kept for backwards compatibility
 */
EMSCRIPTEN_KEEPALIVE
int ipod_track_set_path(int track_index, const char *ipod_path) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    Itdb_Track *track = (Itdb_Track *)g_list_nth_data(g_itdb->tracks, (guint)track_index);
    if (!track) {
        set_error("Track not found at index: %d", track_index);
        return -1;
    }

    if (track->ipod_path) {
        g_free(track->ipod_path);
    }
    track->ipod_path = g_strdup(ipod_path);
    track->transferred = TRUE;

    log_info("Set path for track index %d: %s", track_index, ipod_path);
    return 0;
}

/**
 * Generate iPod destination path for a track using libgpod's proper function
 * Returns allocated string (caller must free) - filesystem path format
 */
EMSCRIPTEN_KEEPALIVE
char* ipod_get_track_dest_path(const char *original_filename) {
    if (!g_itdb || strlen(g_mountpoint) == 0) {
        set_error("No database or mountpoint");
        return NULL;
    }

    GError *error = NULL;
    
    // Use libgpod's proper function to get destination filename
    // This returns a filesystem path (with slashes), not iPod path (with colons)
    gchar *dest_path = itdb_cp_get_dest_filename(NULL, g_mountpoint, original_filename, &error);
    
    if (!dest_path) {
        if (error) {
            set_error("Failed to get destination path: %s", error->message);
            g_error_free(error);
        } else {
            set_error("Failed to get destination path: Unknown error");
        }
        return NULL;
    }
    
    // Return as allocated string (caller must free)
    return strdup(dest_path);
}

/**
 * Remove a track from the database
 * @track_index: index of track in the tracks list (NOT the track ID!)
 */
EMSCRIPTEN_KEEPALIVE
int ipod_remove_track(int track_index) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    Itdb_Track *track = (Itdb_Track *)g_list_nth_data(g_itdb->tracks, (guint)track_index);
    if (!track) {
        set_error("Track not found at index: %d", track_index);
        return -1;
    }

    char *title = track->title ? g_strdup(track->title) : g_strdup("Unknown");

    // CRITICAL: itdb_track_remove does NOT remove tracks from playlists!
    // We must explicitly remove the track from all playlists first to prevent
    // broken links that cause "prepare_itdb_for_write: assertion 'link' failed"
    GList *playlists = g_itdb->playlists;
    for (GList *l = playlists; l != NULL; l = l->next) {
        Itdb_Playlist *pl = (Itdb_Playlist *)l->data;
        if (pl && itdb_playlist_contains_track(pl, track)) {
            itdb_playlist_remove_track(pl, track);
            log_info("Removed track index %d from playlist: %s", track_index, pl->name ? pl->name : "Unknown");
        }
    }

    // Now remove the track from the database
    // This frees the track memory, so we can't access track after this call
    itdb_track_remove(track);

    // Clear last_added_track if it was this track
    if (g_last_added_track == track) {
        g_last_added_track = NULL;
    }

    log_info("Removed track: %s (index: %d)", title, track_index);
    g_free(title);

    return 0;
}

/**
 * Update track metadata
 * @track_index: index of track in the tracks list (NOT the track ID!)
 */
EMSCRIPTEN_KEEPALIVE
int ipod_update_track(
    int track_index,
    const char *title,
    const char *artist,
    const char *album,
    const char *genre,
    int track_nr,
    int year,
    int rating
) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    Itdb_Track *track = (Itdb_Track *)g_list_nth_data(g_itdb->tracks, (guint)track_index);
    if (!track) {
        set_error("Track not found at index: %d", track_index);
        return -1;
    }

    if (title) { g_free(track->title); track->title = sanitize_utf8_string(title); }
    if (artist) { g_free(track->artist); track->artist = sanitize_utf8_string(artist); }
    if (album) { g_free(track->album); track->album = sanitize_utf8_string(album); }
    if (genre) { g_free(track->genre); track->genre = sanitize_utf8_string(genre); }
    if (track_nr >= 0) track->track_nr = track_nr;
    if (year >= 0) track->year = year;
    if (rating >= 0) track->rating = rating;

    track->time_modified = time(NULL);

    log_info("Updated track index: %d", track_index);
    return 0;
}

/* ============================================================================
 * Playlist Functions
 * ============================================================================ */

/**
 * Get total number of playlists
 */
EMSCRIPTEN_KEEPALIVE
int ipod_get_playlist_count(void) {
    if (!g_itdb) return 0;
    return (int)itdb_playlists_number(g_itdb);
}

/**
 * Get playlist info as JSON (caller must free)
 */
EMSCRIPTEN_KEEPALIVE
char* ipod_get_playlist_json(int index) {
    if (!g_itdb) {
        set_error("No database loaded");
        return NULL;
    }

    Itdb_Playlist *pl = itdb_playlist_by_nr(g_itdb, (guint32)index);
    if (!pl) {
        set_error("Playlist index %d out of range", index);
        return NULL;
    }

    char name_esc[512] = "";
    escape_json_string(name_esc, pl->name, sizeof(name_esc));

    char *json = (char *)malloc(2048);
    if (!json) return NULL;

    snprintf(json, 2048,
        "{"
        "\"id\":%llu,"
        "\"name\":\"%s\","
        "\"track_count\":%u,"
        "\"is_master\":%s,"
        "\"is_podcast\":%s,"
        "\"is_smart\":%s"
        "}",
        (unsigned long long)pl->id,
        name_esc,
        itdb_playlist_tracks_number(pl),
        itdb_playlist_is_mpl(pl) ? "true" : "false",
        itdb_playlist_is_podcasts(pl) ? "true" : "false",
        pl->is_spl ? "true" : "false"
    );

    return json;
}

/**
 * Get all playlists as JSON array
 */
EMSCRIPTEN_KEEPALIVE
char* ipod_get_all_playlists_json(void) {
    if (!g_itdb) {
        set_error("No database loaded");
        return NULL;
    }

    int count = ipod_get_playlist_count();
    size_t buf_size = count * 512 + 256;
    char *json = (char *)malloc(buf_size);
    if (!json) return NULL;

    strcpy(json, "[");
    size_t pos = 1;

    for (int i = 0; i < count; i++) {
        char *pl_json = ipod_get_playlist_json(i);
        if (pl_json) {
            size_t pl_len = strlen(pl_json);
            if (pos + pl_len + 10 > buf_size) {
                buf_size *= 2;
                char *new_buf = realloc(json, buf_size);
                if (!new_buf) { free(json); free(pl_json); return NULL; }
                json = new_buf;
            }
            if (i > 0) json[pos++] = ',';
            memcpy(json + pos, pl_json, pl_len);
            pos += pl_len;
            free(pl_json);
        }
    }

    json[pos++] = ']';
    json[pos] = '\0';

    return json;
}

/**
 * Get tracks in a playlist as JSON array
 */
EMSCRIPTEN_KEEPALIVE
char* ipod_get_playlist_tracks_json(int playlist_index) {
    if (!g_itdb) {
        set_error("No database loaded");
        return NULL;
    }

    Itdb_Playlist *pl = itdb_playlist_by_nr(g_itdb, (guint32)playlist_index);
    if (!pl) {
        set_error("Playlist index %d out of range", playlist_index);
        return NULL;
    }

    int count = itdb_playlist_tracks_number(pl);
    size_t buf_size = count * 1024 + 256;
    char *json = (char *)malloc(buf_size);
    if (!json) return NULL;

    strcpy(json, "[");
    size_t pos = 1;

    GList *members = pl->members;
    int idx = 0;
    for (GList *l = members; l != NULL; l = l->next, idx++) {
        Itdb_Track *track = (Itdb_Track *)l->data;
        if (!track) continue;

        /* Find track index in main list */
        int track_idx = g_list_index(g_itdb->tracks, track);
        if (track_idx < 0) continue;

        char *track_json = ipod_get_track_json(track_idx);
        if (track_json) {
            size_t track_len = strlen(track_json);
            if (pos + track_len + 10 > buf_size) {
                buf_size *= 2;
                char *new_buf = realloc(json, buf_size);
                if (!new_buf) { free(json); free(track_json); return NULL; }
                json = new_buf;
            }
            if (idx > 0) json[pos++] = ',';
            memcpy(json + pos, track_json, track_len);
            pos += track_len;
            free(track_json);
        }
    }

    json[pos++] = ']';
    json[pos] = '\0';

    return json;
}

/**
 * Create a new playlist
 * Returns playlist index on success, -1 on error
 */
EMSCRIPTEN_KEEPALIVE
int ipod_create_playlist(const char *name) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    if (!name || strlen(name) == 0) {
        set_error("Playlist name cannot be empty");
        return -1;
    }

    Itdb_Playlist *pl = itdb_playlist_new(name, FALSE);
    if (!pl) {
        set_error("Failed to create playlist");
        return -1;
    }

    itdb_playlist_add(g_itdb, pl, -1);

    /* Find the index */
    int idx = -1;
    GList *playlists = g_itdb->playlists;
    int i = 0;
    for (GList *l = playlists; l != NULL; l = l->next, i++) {
        if (l->data == pl) {
            idx = i;
            break;
        }
    }

    log_info("Created playlist: %s (index: %d)", name, idx);
    return idx;
}

/**
 * Delete a playlist
 */
EMSCRIPTEN_KEEPALIVE
int ipod_delete_playlist(int playlist_index) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    Itdb_Playlist *pl = itdb_playlist_by_nr(g_itdb, (guint32)playlist_index);
    if (!pl) {
        set_error("Playlist index %d out of range", playlist_index);
        return -1;
    }

    if (itdb_playlist_is_mpl(pl)) {
        set_error("Cannot delete master playlist");
        return -1;
    }

    char *name = pl->name ? g_strdup(pl->name) : g_strdup("Unknown");

    itdb_playlist_remove(pl);

    log_info("Deleted playlist: %s", name);
    g_free(name);

    return 0;
}

/**
 * Rename a playlist
 */
EMSCRIPTEN_KEEPALIVE
int ipod_rename_playlist(int playlist_index, const char *new_name) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    Itdb_Playlist *pl = itdb_playlist_by_nr(g_itdb, (guint32)playlist_index);
    if (!pl) {
        set_error("Playlist index %d out of range", playlist_index);
        return -1;
    }

    if (!new_name || strlen(new_name) == 0) {
        set_error("Playlist name cannot be empty");
        return -1;
    }

    g_free(pl->name);
    pl->name = g_strdup(new_name);

    log_info("Renamed playlist %d to: %s", playlist_index, new_name);
    return 0;
}

/**
 * Add a track to a playlist
 * @track_index: index of track in the tracks list (NOT the track ID!)
 */
EMSCRIPTEN_KEEPALIVE
int ipod_playlist_add_track(int playlist_index, int track_index) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    Itdb_Playlist *pl = itdb_playlist_by_nr(g_itdb, (guint32)playlist_index);
    if (!pl) {
        set_error("Playlist index %d out of range", playlist_index);
        return -1;
    }

    Itdb_Track *track = (Itdb_Track *)g_list_nth_data(g_itdb->tracks, (guint)track_index);
    if (!track) {
        set_error("Track not found at index: %d", track_index);
        return -1;
    }

    if (itdb_playlist_contains_track(pl, track)) {
        log_info("Track index %d already in playlist %d", track_index, playlist_index);
        return 0; /* Not an error */
    }

    itdb_playlist_add_track(pl, track, -1);

    log_info("Added track index %d to playlist %d", track_index, playlist_index);
    return 0;
}

/**
 * Remove a track from a playlist
 * @track_index: index of track in the tracks list (NOT the track ID!)
 */
EMSCRIPTEN_KEEPALIVE
int ipod_playlist_remove_track(int playlist_index, int track_index) {
    if (!g_itdb) {
        set_error("No database loaded");
        return -1;
    }

    Itdb_Playlist *pl = itdb_playlist_by_nr(g_itdb, (guint32)playlist_index);
    if (!pl) {
        set_error("Playlist index %d out of range", playlist_index);
        return -1;
    }

    Itdb_Track *track = (Itdb_Track *)g_list_nth_data(g_itdb->tracks, (guint)track_index);
    if (!track) {
        set_error("Track not found at index: %d", track_index);
        return -1;
    }

    if (!itdb_playlist_contains_track(pl, track)) {
        set_error("Track index %d not in playlist %d", track_index, playlist_index);
        return -1;
    }

    itdb_playlist_remove_track(pl, track);

    log_info("Removed track index %d from playlist %d", track_index, playlist_index);
    return 0;
}


/* ============================================================================
 * File Copy Helper (for manual file placement)
 * ============================================================================ */

/**
 * Convert filesystem path to iPod path format
 * Uses libgpod's canonical conversion (fs -> ipod)
 *
 * NOTE: Returns a malloc()'d string (free with ipod_free_string / free()).
 */
EMSCRIPTEN_KEEPALIVE
char* ipod_path_to_ipod_format(const char *fs_path) {
    if (!fs_path) return NULL;

    char *ipod_path = strdup(fs_path);
    if (!ipod_path) return NULL;

    itdb_filename_fs2ipod(ipod_path);

    return ipod_path;
}

/**
 * Convert iPod path to filesystem path format
 * Uses libgpod's canonical conversion (ipod -> fs)
 *
 * NOTE: Returns a malloc()'d string (free with ipod_free_string / free()).
 */
EMSCRIPTEN_KEEPALIVE
char* ipod_path_to_fs_format(const char *ipod_path) {
    if (!ipod_path) return NULL;

    char *fs_path = strdup(ipod_path);
    if (!fs_path) return NULL;

    itdb_filename_ipod2fs(fs_path);

    return fs_path;
}
