# Ozon Seller API Listing Field Notes

Checked: 2026-06-25

## Local Files

- `official-listing-base.json`: local base listing field table for the workflow.
- `ozon-seller-swagger.json`: raw swagger copied from `/Users/gl001426/Desktop/swagger.json`.
- `ozon-seller-swagger-summary.json`: extracted product import/category API summary from the raw swagger.
- `seller-api-research.md`: this human-readable research note.

## Official Sources Checked

- Ozon for dev: Automatic product import/update through Seller API  
  https://dev.ozon.ru/start/294-Avtomaticheskii-import-i-obnovlenie-tovarov-v-Seller-API/
- Ozon for dev: `type_id` usage in Seller API  
  https://dev.ozon.ru/start/334-Ispolzovanie-polia-type-id-v-Seller-API/
- Ozon Seller API reference root  
  https://docs.ozon.ru/api/seller/

The `docs.ozon.ru` API reference and `swagger.json` URL were attempted locally, but the site returned repeated `307` redirects with `__rr` query parameters. The raw swagger was then copied manually from the user's Desktop.

## Confirmed Seller API Flow

1. Fetch category/type tree:
   - `POST /v1/description-category/tree`
2. Match/select the listing's `description_category_id` and `type_id`.
3. Fetch category-specific attributes:
   - `POST /v1/description-category/attribute`
4. For attributes with dictionary values, fetch allowed values:
   - `POST /v1/description-category/attribute/values`
5. When AI has a candidate value for a dictionary attribute, search Ozon reference values:
   - `POST /v1/description-category/attribute/values/search`
6. Build product import payload and submit:
   - `POST /v3/product/import`

## Category Attribute API Rules

The category/type and attribute APIs are the source of truth for required characteristics:

- Category and product type tree:
  - `POST /v1/description-category/tree`
  - Use the returned `description_category_id` and `type_id`.
- Category feature list:
  - `POST /v1/description-category/attribute`
  - Required request fields: `description_category_id`, `type_id`.
  - Important response fields: `id`, `name`, `type`, `is_required`, `dictionary_id`, `is_collection`, `is_aspect`, `max_value_count`, `category_dependent`, `group_name`.
- Feature value guide:
  - `POST /v1/description-category/attribute/values`
  - Required request fields: `attribute_id`, `description_category_id`, `type_id`, `limit`.
  - Use `last_value_id` and `has_next` for pagination.
- Reference value search:
  - `POST /v1/description-category/attribute/values/search`
  - Required request fields: `attribute_id`, `description_category_id`, `type_id`, `limit`, `value`.
  - Use this when AI extracts a candidate value and the attribute has `dictionary_id`.

Implementation rule: do not let AI invent uploadable dictionary IDs. AI may suggest text, but the final value should be selected from `/attribute/values` or `/attribute/values/search` when `dictionary_id` is present.

## Important Design Decision

Do not hard-code category-specific required attributes. Ozon attributes depend on `description_category_id` and `type_id`, so the workflow should:

1. Always show a base listing field table.
2. Use AI pass 1 to match the Ozon category/type from crawler JSON and the local category tree.
3. Fetch and show category-specific required, dictionary, and conditional fields.
4. Use AI pass 2 to fill feature values from crawler JSON, OCR/image extraction, user defaults, common-sense product knowledge, and the fetched Ozon attribute/value list.
5. Keep every value editable before upload. Base/category field names are fixed.

## Base Listing Fields Stored Locally

The provided swagger's `v3ImportProductsRequestItem` official required fields are:

- `description_category_id`
- `price`
- `type_id`

The local workflow still shows more base fields because they are either part of the official item schema, needed for upload quality, or used by the existing local `OZON_HD` cleaner/upload payload.

The local base table contains:

- Ozon category/type: `description_category_id/type_id`
- Seller SKU: `offer_id`
- Product name: `name`
- Short description / brief: `description`
- Tags/keywords: local operational field for search/AI review, not an official `/v3/product/import` item property in the provided swagger
- Brand
- Price: `price`
- Old price: `old_price`
- Minimum price: `min_price`
- Currency: `currency_code`
- Barcode: `barcode`
- Images: `primary_image/images`
- Package/logistics fields:
  - `weight`
  - `weight_unit`
  - `depth`
  - `width`
  - `height`
  - `dimension_unit`

## Content Quality / Category Fields

The Ozon seller UI also shows content-quality and category-attribute fields such as:

- Shelf life in days
- Storage conditions
- Composition/ingredients
- Quantity in the unified measurement unit
- Topic hashtags
- Brief/short product text
- Production process
- Minimum/maximum temperature

These fields are not separate top-level properties of `v3ImportProductsRequestItem` in the provided swagger. The local workflow does not show them in the initial base table. They appear after category matching when `/v1/description-category/attribute` returns matching required, dictionary, or conditional attributes.

Implementation rule:

1. Do not show these fields before category matching.
2. After `description_category_id` and `type_id` are selected, map them to real category attributes from `/v1/description-category/attribute`.
3. Fill them from crawler JSON, OCR and AI when possible.
4. Keep all values editable before upload.

## Current Local Limitation

Current `.env` values are empty:

- `OZON_CLIENT_ID=""`
- `OZON_API_KEY=""`
- `OZON_HD_CACHE_DIR=""`

Current cache is also missing:

- `OZON_HD/cache/category_tree.json`

Until one of those sources is available, category-specific Ozon attributes cannot be fetched. The app can still generate the base table and source-feature draft.
