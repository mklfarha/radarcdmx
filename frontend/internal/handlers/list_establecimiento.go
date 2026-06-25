package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/guregu/null/v6"
	"github.com/mklfarha/radarcdmx/backend/rcapi/core"
	establecimientotypes "github.com/mklfarha/radarcdmx/backend/rcapi/core/module/establecimiento/types"
	repogen "github.com/mklfarha/radarcdmx/backend/rcapi/core/repository/gen"
	"github.com/mklfarha/radarcdmx/backend/rcapi/entity/contacto"
	mainentity "github.com/mklfarha/radarcdmx/backend/rcapi/entity/establecimiento"
	"github.com/mklfarha/radarcdmx/backend/rcapi/entity/mapper"
	"github.com/mklfarha/radarcdmx/backend/rcapi/entity/ubicacion"
)

const listEstablecimientosNearbyQuerySelect = `
SELECT
	e.uuid,
	e.id_denue,
	e.clee,
	e.nombre,
	e.razon_social,
	e.per_ocu,
	e.codigo_actividad,
	e.nombre_actividad,
	e.uso_de_suelo,
	e.clave_catastral,
	e.contacto,
	e.ubicacion,
	e.fecha_alta,
	e.created_at,
	e.updated_at,
	ST_Distance_Sphere(
		POINT(
			CAST(JSON_UNQUOTE(JSON_EXTRACT(e.ubicacion, '$.longitud')) AS DECIMAL(12,8)),
			CAST(JSON_UNQUOTE(JSON_EXTRACT(e.ubicacion, '$.latitud')) AS DECIMAL(12,8))
		),
		POINT(?, ?)
	) AS distance_m
FROM establecimiento e`

// ListEstablecimientoHandler lists establecimientos using rcapi as an in-process library.
type ListEstablecimientoHandler struct {
	logger *log.Logger
	core   *core.Implementation
}

// NewListEstablecimientoHandler constructs ListEstablecimientoHandler.
func NewListEstablecimientoHandler(logger *log.Logger, rcapiCore *core.Implementation) *ListEstablecimientoHandler {
	return &ListEstablecimientoHandler{logger: logger, core: rcapiCore}
}

func (h *ListEstablecimientoHandler) Method() string  { return http.MethodGet }
func (h *ListEstablecimientoHandler) Pattern() string { return "/api/establecimientos" }

func (h *ListEstablecimientoHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	pageSize := int32(20)
	offset := int64(0)

	if raw := r.URL.Query().Get("page_size"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || parsed <= 0 {
			http.Error(w, "invalid page_size", http.StatusBadRequest)
			return
		}
		pageSize = int32(parsed)
	}

	if raw := r.URL.Query().Get("offset"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			http.Error(w, "invalid offset", http.StatusBadRequest)
			return
		}
		offset = parsed
	}

	res, err := h.core.Establecimiento().List(r.Context(), establecimientotypes.ListRequest{
		PageSize: pageSize,
		Offset:   offset,
	})
	if err != nil {
		h.logger.Printf("rcapi list establecimientos: %v", err)
		http.Error(w, "failed to list establecimientos", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(res); err != nil {
		h.logger.Printf("encode response: %v", err)
	}
}

// ListEstablecimientoNearbyHandler lists establecimientos near a point within a radius.
type ListEstablecimientoNearbyHandler struct {
	logger *log.Logger
	core   *core.Implementation
}

// NewListEstablecimientoNearbyHandler constructs ListEstablecimientoNearbyHandler.
func NewListEstablecimientoNearbyHandler(logger *log.Logger, rcapiCore *core.Implementation) *ListEstablecimientoNearbyHandler {
	return &ListEstablecimientoNearbyHandler{logger: logger, core: rcapiCore}
}

func (h *ListEstablecimientoNearbyHandler) Method() string  { return http.MethodGet }
func (h *ListEstablecimientoNearbyHandler) Pattern() string { return "/api/establecimientos/nearby" }

type nearbyEstablecimiento struct {
	Establecimiento mainentity.Establecimiento `json:"establecimiento"`
	DistanceMeters  float64                    `json:"distance_meters"`
}

type listEstablecimientosNearbyResponse struct {
	Items []nearbyEstablecimiento `json:"items"`
}

func (h *ListEstablecimientoNearbyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	lat, err := parseRequiredFloat(query.Get("lat"))
	if err != nil || lat < -90 || lat > 90 {
		http.Error(w, "invalid lat", http.StatusBadRequest)
		return
	}

	lng, err := parseRequiredFloat(query.Get("lng"))
	if err != nil || lng < -180 || lng > 180 {
		http.Error(w, "invalid lng", http.StatusBadRequest)
		return
	}

	// Bounding-box mode: when min/max lat/lng are all provided we filter by the
	// viewport rectangle instead of a radius. This avoids the "disk" artifact
	// caused by ORDER BY distance + LIMIT, which returns the nearest N points
	// (a circle centered on the user) when the area holds more than page_size
	// establecimientos. radius_m stays required only when no bbox is given.
	bbox, hasBBox, err := parseBoundingBox(query)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var radiusMeters float64
	if !hasBBox {
		radiusMeters, err = parseRequiredFloat(query.Get("radius_m"))
		if err != nil || radiusMeters <= 0 {
			http.Error(w, "invalid radius_m", http.StatusBadRequest)
			return
		}
	}

	pageSize := int64(20)
	offset := int64(0)
	var codigoActividad *int64
	usoDeSuelo := strings.TrimSpace(query.Get("uso_de_suelo"))
	municipio := strings.TrimSpace(query.Get("municipio"))
	q := strings.TrimSpace(query.Get("q"))

	if raw := query.Get("codigo_actividad"); raw != "" {
		parsed, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || parsed < 0 {
			http.Error(w, "invalid codigo_actividad", http.StatusBadRequest)
			return
		}
		codigoActividad = &parsed
	}

	if raw := query.Get("page_size"); raw != "" {
		parsed, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || parsed <= 0 {
			http.Error(w, "invalid page_size", http.StatusBadRequest)
			return
		}
		pageSize = parsed
	}

	if raw := query.Get("offset"); raw != "" {
		parsed, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || parsed < 0 {
			http.Error(w, "invalid offset", http.StatusBadRequest)
			return
		}
		offset = parsed
	}

	// The SELECT always computes distance_m from POINT(?, ?), so lng/lat are the
	// first two bind args regardless of mode.
	whereClauses := []string{
		"JSON_EXTRACT(e.ubicacion, '$.latitud') IS NOT NULL",
		"JSON_EXTRACT(e.ubicacion, '$.longitud') IS NOT NULL",
	}
	args := []any{lng, lat}

	orderBy := "distance_m ASC"
	if hasBBox {
		// Filter to the viewport rectangle and order by a non-spatial key so a
		// page_size clip thins points out evenly rather than carving a circle.
		whereClauses = append(whereClauses,
			"CAST(JSON_UNQUOTE(JSON_EXTRACT(e.ubicacion, '$.latitud')) AS DECIMAL(12,8)) BETWEEN ? AND ?",
			"CAST(JSON_UNQUOTE(JSON_EXTRACT(e.ubicacion, '$.longitud')) AS DECIMAL(12,8)) BETWEEN ? AND ?",
		)
		args = append(args, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng)
		// uuid is a random CHAR(36) PK, so a page_size clip yields a roughly
		// uniform spatial sample across the viewport instead of a circle.
		orderBy = "e.uuid ASC"
	} else {
		whereClauses = append(whereClauses, `ST_Distance_Sphere(
			POINT(
				CAST(JSON_UNQUOTE(JSON_EXTRACT(e.ubicacion, '$.longitud')) AS DECIMAL(12,8)),
				CAST(JSON_UNQUOTE(JSON_EXTRACT(e.ubicacion, '$.latitud')) AS DECIMAL(12,8))
			),
			POINT(?, ?)
		) <= ?`)
		args = append(args, lng, lat, radiusMeters)
	}

	if codigoActividad != nil {
		whereClauses = append(whereClauses, "e.codigo_actividad = ?")
		args = append(args, *codigoActividad)
	}

	if usoDeSuelo != "" {
		whereClauses = append(whereClauses, "LOWER(e.uso_de_suelo) = LOWER(?)")
		args = append(args, usoDeSuelo)
	}

	if municipio != "" {
		whereClauses = append(whereClauses, "LOWER(JSON_UNQUOTE(JSON_EXTRACT(e.ubicacion, '$.municipio'))) = LOWER(?)")
		args = append(args, municipio)
	}

	if q != "" {
		whereClauses = append(whereClauses, "(LOWER(e.nombre) LIKE LOWER(?) OR LOWER(e.razon_social) LIKE LOWER(?))")
		args = append(args, "%"+q+"%", "%"+q+"%")
	}

	finalQuery := listEstablecimientosNearbyQuerySelect + "\nWHERE " + strings.Join(whereClauses, "\n\tAND ") + "\nORDER BY " + orderBy + "\nLIMIT ?, ?"
	args = append(args, offset, pageSize)

	rows, err := h.core.DB().QueryContext(r.Context(), finalQuery, args...)
	if err != nil {
		h.logger.Printf("rcapi nearby establecimientos query: %v", err)
		http.Error(w, "failed to list nearby establecimientos", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	items := make([]nearbyEstablecimiento, 0)
	for rows.Next() {
		var model repogen.Establecimiento
		var distanceMeters float64

		if err := rows.Scan(
			&model.UUID,
			&model.IdDenue,
			&model.Clee,
			&model.Nombre,
			&model.RazonSocial,
			&model.PerOcu,
			&model.CodigoActividad,
			&model.NombreActividad,
			&model.UsoDeSuelo,
			&model.ClaveCatastral,
			&model.Contacto,
			&model.Ubicacion,
			&model.FechaAlta,
			&model.CreatedAt,
			&model.UpdatedAt,
			&distanceMeters,
		); err != nil {
			h.logger.Printf("scan nearby establecimientos row: %v", err)
			http.Error(w, "failed to decode nearby establecimientos", http.StatusInternalServerError)
			return
		}

		items = append(items, nearbyEstablecimiento{
			Establecimiento: mapEstablecimientoModelToEntity(model),
			DistanceMeters:  distanceMeters,
		})
	}

	if err := rows.Err(); err != nil {
		h.logger.Printf("nearby establecimientos rows: %v", err)
		http.Error(w, "failed to list nearby establecimientos", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(listEstablecimientosNearbyResponse{Items: items}); err != nil {
		h.logger.Printf("encode nearby response: %v", err)
	}
}

func parseRequiredFloat(raw string) (float64, error) {
	if raw == "" {
		return 0, sql.ErrNoRows
	}
	return strconv.ParseFloat(raw, 64)
}

type boundingBox struct {
	minLat, maxLat, minLng, maxLng float64
}

// parseBoundingBox reads the optional min_lat/max_lat/min_lng/max_lng query
// params. It returns (box, true, nil) when all four are present and valid,
// (zero, false, nil) when none are present, and an error when the set is
// incomplete or out of range.
func parseBoundingBox(query url.Values) (boundingBox, bool, error) {
	keys := []string{"min_lat", "max_lat", "min_lng", "max_lng"}
	present := 0
	for _, k := range keys {
		if query.Get(k) != "" {
			present++
		}
	}
	if present == 0 {
		return boundingBox{}, false, nil
	}
	if present != len(keys) {
		return boundingBox{}, false, errors.New("bounding box requires min_lat, max_lat, min_lng and max_lng")
	}

	vals := make([]float64, len(keys))
	for i, k := range keys {
		v, err := strconv.ParseFloat(query.Get(k), 64)
		if err != nil {
			return boundingBox{}, false, fmt.Errorf("invalid %s", k)
		}
		vals[i] = v
	}

	box := boundingBox{minLat: vals[0], maxLat: vals[1], minLng: vals[2], maxLng: vals[3]}
	if box.minLat < -90 || box.maxLat > 90 || box.minLng < -180 || box.maxLng > 180 {
		return boundingBox{}, false, errors.New("bounding box out of range")
	}
	if box.minLat > box.maxLat || box.minLng > box.maxLng {
		return boundingBox{}, false, errors.New("bounding box min must be <= max")
	}
	return box, true, nil
}

func mapEstablecimientoModelToEntity(m repogen.Establecimiento) mainentity.Establecimiento {
	return mainentity.Establecimiento{
		UUID:            mapper.StringToUUID(m.UUID),
		IdDenue:         null.NewInt(m.IdDenue.Int64, m.IdDenue.Valid),
		Clee:            null.NewString(m.Clee.String, m.Clee.Valid),
		Nombre:          null.NewString(m.Nombre.String, m.Nombre.Valid),
		RazonSocial:     null.NewString(m.RazonSocial.String, m.RazonSocial.Valid),
		PerOcu:          null.NewString(m.PerOcu.String, m.PerOcu.Valid),
		CodigoActividad: null.NewInt(m.CodigoActividad.Int64, m.CodigoActividad.Valid),
		NombreActividad: null.NewString(m.NombreActividad.String, m.NombreActividad.Valid),
		UsoDeSuelo:      null.NewString(m.UsoDeSuelo.String, m.UsoDeSuelo.Valid),
		ClaveCatastral:  null.NewString(m.ClaveCatastral.String, m.ClaveCatastral.Valid),
		Contacto:        contacto.ContactoFromJSON(m.Contacto),
		Ubicacion:       ubicacion.UbicacionFromJSON(m.Ubicacion),
		FechaAlta:       null.NewTime(m.FechaAlta.Time, m.FechaAlta.Valid),
		CreatedAt:       m.CreatedAt,
		UpdatedAt:       m.UpdatedAt,
	}
}
