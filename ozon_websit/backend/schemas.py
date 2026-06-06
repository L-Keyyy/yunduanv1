from datetime import datetime
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field


class StoreBase(BaseModel):
    store_name: str
    client_id: str
    api_key: str
    email: Optional[str] = None
    store_group: Optional[str] = None
    currency: Optional[str] = "CNY"


class StoreCreate(StoreBase):
    pass


class StoreUpdate(BaseModel):
    store_name: Optional[str] = None
    client_id: Optional[str] = None
    api_key: Optional[str] = None
    email: Optional[str] = None
    store_group: Optional[str] = None
    currency: Optional[str] = None


class StoreResponse(BaseModel):
    id: int
    tenant_id: Optional[int] = None
    store_name: str
    client_id: str
    currency: Optional[str] = None
    email: Optional[str] = None
    store_group: Optional[str] = None
    key_status: str
    info: Optional[str] = None
    can_create: Union[str, int, bool]
    can_update: Union[str, int, bool]
    daily_limit: Union[str, int]
    total_limit: Union[str, int]
    watermark: str
    warehouse_info: Optional[str] = None
    cookie_status: str
    status_update_time: Optional[datetime] = None
    add_time: Optional[datetime] = None
    user_owner: str

    class Config:
        from_attributes = True


class AuthLoginRequest(BaseModel):
    username: str
    password: str


class AuthRegisterRequest(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None
    email: Optional[str] = None


class AuthUserResponse(BaseModel):
    id: int
    username: str
    display_name: str
    email: Optional[str] = None
    is_admin: bool = False
    is_super_admin: bool = False
    is_tenant_admin: bool = False
    is_active: bool = True
    tenant_id: Optional[int] = None
    tenant_name: Optional[str] = None
    roles: List[str] = Field(default_factory=list)


class AuthLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: AuthUserResponse


class AdminOverviewResponse(BaseModel):
    tenants: int
    users: int
    stores: int
    products: int
    orders: int
    active_subscriptions: int


class AdminTenantResponse(BaseModel):
    id: int
    name: str
    slug: str
    status: str
    plan_code: str
    subscription_status: str
    store_limit: int
    user_limit: int
    expires_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    stores_count: int = 0
    users_count: int = 0
    max_daily_create: Optional[int] = None
    max_daily_update: Optional[int] = None
    max_total_products: Optional[int] = None

    class Config:
        from_attributes = True


class AdminTenantUpdateRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    plan_code: Optional[str] = None
    subscription_status: Optional[str] = None
    store_limit: Optional[int] = Field(default=None, ge=0)
    user_limit: Optional[int] = Field(default=None, ge=0)
    expires_at: Optional[datetime] = None
    max_daily_create: Optional[int] = Field(default=None, ge=0)
    max_daily_update: Optional[int] = Field(default=None, ge=0)
    max_total_products: Optional[int] = Field(default=None, ge=0)


class AdminTenantCreateRequest(BaseModel):
    name: str
    slug: Optional[str] = None
    status: str = "active"
    plan_code: str = "starter"
    subscription_status: str = "active"
    store_limit: int = Field(default=1, ge=0)
    user_limit: int = Field(default=3, ge=0)
    expires_at: Optional[datetime] = None
    max_daily_create: int = Field(default=250, ge=0)
    max_daily_update: int = Field(default=5000, ge=0)
    max_total_products: int = Field(default=8000, ge=0)


class AdminUserResponse(BaseModel):
    id: int
    username: str
    display_name: str
    email: Optional[str] = None
    is_active: bool
    is_admin: bool
    primary_tenant_id: Optional[int] = None
    tenant_name: Optional[str] = None
    roles: List[str] = Field(default_factory=list)
    created_at: Optional[datetime] = None
    last_login_at: Optional[datetime] = None


class AdminUserCreateRequest(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None
    email: Optional[str] = None
    tenant_id: int
    is_active: bool = True
    roles: List[str] = Field(default_factory=lambda: ["user"])


class AdminUserUpdateRequest(BaseModel):
    display_name: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    tenant_id: Optional[int] = None
    is_active: Optional[bool] = None
    roles: Optional[List[str]] = None


class AdminRoleResponse(BaseModel):
    id: int
    tenant_id: Optional[int] = None
    code: str
    name: str
    scope: str
    is_system: bool

    class Config:
        from_attributes = True


class AdminPermissionResponse(BaseModel):
    id: int
    code: str
    name: str
    group: Optional[str] = None
    description: Optional[str] = None

    class Config:
        from_attributes = True


class AdminMenuResponse(BaseModel):
    id: int
    code: str
    title: str
    path: Optional[str] = None
    parent_code: Optional[str] = None
    sort_order: int
    required_permission: Optional[str] = None
    is_admin: bool
    is_active: bool

    class Config:
        from_attributes = True


class AdminAuditLogResponse(BaseModel):
    id: int
    tenant_id: Optional[int] = None
    user_id: Optional[int] = None
    actor_username: Optional[str] = None
    action: str
    resource_type: Optional[str] = None
    resource_id: Optional[str] = None
    details: Optional[str] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class AdminLoginLogResponse(BaseModel):
    id: int
    tenant_id: Optional[int] = None
    user_id: Optional[int] = None
    username: str
    role_scope: Optional[str] = None
    success: bool
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    failure_reason: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class AdminCacheStatusResponse(BaseModel):
    activity_query_entries: int
    activity_product_detail_entries: int
    seller_market_trends_entries: int
    seller_market_all_roots_entries: int
    seller_hot_tags_entries: int
    seller_product_market_entries: int


class AdminCacheClearRequest(BaseModel):
    scope: str = "all"


class AdminCacheClearResponse(AdminCacheStatusResponse):
    cleared_scope: str


class AdminSellerAnalyticsSyncRequest(BaseModel):
    tenant_id: Optional[int] = None
    store_id: Optional[int] = None
    days: int = Field(default=7, ge=1, le=365)


class UploadJobCreate(BaseModel):
    store_id: Optional[int] = None
    store_name: Optional[str] = None
    items: List[Dict[str, Any]]
    source: Optional[str] = None
    local_task_id: Optional[str] = None


class UploadJobItemResponse(BaseModel):
    id: int
    upload_job_id: int
    store_id: int
    offer_id: str
    sku: Optional[str] = None
    status: str
    request_payload: Dict[str, Any]
    result_payload: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    ozon_product_id: Optional[str] = None
    attempt_count: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class UploadJobResponse(BaseModel):
    id: int
    store_id: int
    store_name: Optional[str] = None
    status: str
    item_count: int
    source: Optional[str] = None
    local_task_id: Optional[str] = None
    ozon_task_id: Optional[str] = None
    attempt_count: int = 0
    max_attempts: int = 3
    celery_task_id: Optional[str] = None
    locked_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    next_attempt_at: Optional[datetime] = None
    last_refreshed_at: Optional[datetime] = None
    next_refresh_at: Optional[datetime] = None
    cancel_requested: bool = False
    canceled_at: Optional[datetime] = None
    timeout_seconds: int = 900
    request_payload: Dict[str, Any]
    result_payload: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    items: List[UploadJobItemResponse] = Field(default_factory=list)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class UploadJobListResponse(BaseModel):
    result: List[UploadJobResponse]


class ExtensionUploadRequest(BaseModel):
    scrapedJson: Union[Dict[str, Any], str]
    price: Optional[Union[str, float, int]] = None
    old_price: Optional[Union[str, float, int]] = None
    follow_min_price: Optional[Union[str, float, int]] = None
    model: Optional[str] = None
    store_id: Optional[int] = None


class ExtensionUploadResponse(BaseModel):
    ok: bool = True
    product_id: str
    job_id: str
    title: Optional[str] = None
    status: str
    price: Optional[str] = None
    store_id: Optional[int] = None


class ExtensionProductStatusResponse(BaseModel):
    ok: bool = True
    product_id: str
    source_product_id: Optional[str] = None
    title: Optional[str] = None
    offer_id: Optional[str] = None
    status: str
    price: Optional[str] = None
    images_count: int = 0
    ozon_task_id: Optional[str] = None
    cloud_upload_job_id: Optional[int] = None
    cloud_upload_status: Optional[str] = None
    cloud_store_id: Optional[int] = None
    errors: Optional[Dict[str, Any]] = None
    attributes_count: int = 0
    category_info: Optional[Dict[str, Any]] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    job_id: Optional[str] = None
    job_status: Optional[str] = None
    job_error: Optional[str] = None
    job_result: Optional[Dict[str, Any]] = None
    ozon_status: Optional[Dict[str, Any]] = None


class CloudFollowPreviewRequest(BaseModel):
    reference: str
    use_browser_session: bool = True
    preferred_url_fragment: Optional[str] = None
    front_cookie: Optional[str] = None
    user_agent: Optional[str] = None


class CloudFollowPreviewResponse(BaseModel):
    ok: bool = True
    reference: str
    resolved_product_id: int
    source_url: str
    fetch_source: Optional[str] = None
    page_url: Optional[str] = None
    title: Optional[str] = None
    variant_count: int = 0
    characteristics_count: int = 0
    has_description: bool = False
    has_price: bool = False
    product_data: Dict[str, Any] = Field(default_factory=dict)


class CloudFollowSubmitRequest(BaseModel):
    reference: str
    store_id: Optional[int] = None
    include_variants: bool = False
    max_variants: int = Field(default=20, ge=1, le=100)
    price: Optional[Union[str, float, int]] = None
    old_price: Optional[Union[str, float, int]] = None
    follow_min_price: Optional[Union[str, float, int]] = None
    model: Optional[str] = None
    use_browser_session: bool = True
    preferred_url_fragment: Optional[str] = None
    front_cookie: Optional[str] = None
    user_agent: Optional[str] = None


class CloudFollowSubmitResponse(BaseModel):
    ok: bool = True
    job_id: str
    status: str
    store_id: int
    item_count: int
    variant_mode: str
    resolved_product_id: int
    source_url: str
    fetch_source: Optional[str] = None
    skipped_variants: int = 0


class CloudFollowCollectTaskItem(BaseModel):
    reference: str
    price: Optional[Union[str, float, int]] = None
    old_price: Optional[Union[str, float, int]] = None
    follow_min_price: Optional[Union[str, float, int]] = None
    model: Optional[str] = None


class CloudFollowCollectTaskCreateRequest(BaseModel):
    store_id: Optional[int] = None
    include_variants: bool = False
    max_variants: int = Field(default=20, ge=1, le=100)
    tasks: List[CloudFollowCollectTaskItem]


class CloudFollowCollectTaskResponse(BaseModel):
    id: int
    tenant_id: Optional[int] = None
    user_owner: str
    store_id: int
    reference: str
    resolved_product_id: Optional[str] = None
    status: str
    include_variants: bool = False
    max_variants: int = 20
    price: Optional[str] = None
    old_price: Optional[str] = None
    follow_min_price: Optional[str] = None
    model: Optional[str] = None
    source_url: Optional[str] = None
    error: Optional[str] = None
    upload_job_id: Optional[int] = None
    claimed_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class CloudFollowCollectTaskCreateResponse(BaseModel):
    ok: bool = True
    result: List[CloudFollowCollectTaskResponse]


class ExtensionCloudFollowClaimRequest(BaseModel):
    limit: int = Field(default=1, ge=1, le=5)
    device_id: Optional[str] = None


class ExtensionCloudFollowClaimResponse(BaseModel):
    ok: bool = True
    result: List[CloudFollowCollectTaskResponse] = Field(default_factory=list)


class ExtensionCloudFollowResultRequest(BaseModel):
    ok: bool = True
    product_data: Optional[Dict[str, Any]] = None
    product_data_list: Optional[List[Dict[str, Any]]] = None
    error: Optional[str] = None


class CloudFollowConfigRequest(BaseModel):
    front_cookie: Optional[str] = None
    user_agent: Optional[str] = None


class CloudFollowConfigResponse(BaseModel):
    front_cookie: Optional[str] = None
    user_agent: Optional[str] = None
    updated_at: Optional[datetime] = None


class DashboardSummaryResponse(BaseModel):
    today_orders: int
    pending_fbs_orders: int
    total_products: int
    low_stock_alerts: int
    active_stores: int
    submitted_jobs: int
    completed_jobs: int
    failed_jobs: int
    successful_uploaded_skus: int


class StorePatchRequest(BaseModel):
    store_name: Optional[str] = None
    email: Optional[str] = None
    store_group: Optional[str] = None
    currency: Optional[str] = None
    watermark: Optional[str] = None
    warehouse_info: Optional[str] = None
    cookie_status: Optional[str] = None


class StoreWarehouseOption(BaseModel):
    warehouse_id: int
    name: str
    status: Optional[str] = None
    status_lms: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None


class StoreWarehouseSyncResponse(BaseModel):
    message: str
    store_id: int
    company_id: int
    seller_url: str
    warehouses: List[StoreWarehouseOption] = Field(default_factory=list)


class ProductResponse(BaseModel):
    id: int
    store_id: int
    store_name: Optional[str] = None
    upload_job_id: Optional[int] = None
    offer_id: str
    sku: Optional[str] = None
    article_no: Optional[str] = None
    product_name: str
    primary_image: Optional[str] = None
    info: Optional[str] = None
    source: Optional[str] = None
    category_level_1: Optional[str] = None
    category_level_2: Optional[str] = None
    category_level_3: Optional[str] = None
    status: str
    archived: bool
    auto_restock: bool
    scheduled_shelf: Optional[str] = None
    warehouse_name: Optional[str] = None
    price: float
    display_price: float
    profit: float
    stock: int
    backup_stock: int
    weight_g: float
    length_mm: float
    width_mm: float
    height_mm: float
    remark: Optional[str] = None
    country: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ProductListResponse(BaseModel):
    result: List[ProductResponse]
    total: int
    page: int
    page_size: int


class ProductMarketInsightsResponse(BaseModel):
    matched: bool = False
    matched_by: Optional[str] = None
    period: str
    update_date: Optional[str] = None
    total: int = 0
    source_url: Optional[str] = None
    query: Dict[str, Any] = Field(default_factory=dict)
    benchmark: Dict[str, Any] = Field(default_factory=dict)
    item: Optional[Dict[str, Any]] = None


class ProductCategoryOption(BaseModel):
    level_1: Optional[str] = None
    level_2: Optional[str] = None
    level_3: Optional[str] = None


class ProductFilterResponse(BaseModel):
    categories: List[ProductCategoryOption]
    sources: List[str]
    statuses: List[str]


class ProductBatchIdsRequest(BaseModel):
    ids: List[int] = Field(default_factory=list)
    store_id: Optional[int] = None


class ProductBatchPriceRequest(ProductBatchIdsRequest):
    price: float
    display_price: Optional[float] = None


class ProductBatchStockRequest(ProductBatchIdsRequest):
    stock: int
    apply_to_filtered: bool = False
    sku: Optional[str] = None
    article_no: Optional[str] = None
    warehouse_name: Optional[str] = None
    backup_status: Optional[str] = None
    archive_status: Optional[str] = "unarchived"


class ProductBatchRemarkRequest(ProductBatchIdsRequest):
    remark: str


class ProductBatchArchiveRequest(ProductBatchIdsRequest):
    archived: bool = True


class InventoryAutomationRequest(ProductBatchIdsRequest):
    auto_restock: Optional[bool] = None
    scheduled_shelf: Optional[str] = None


class OrderResponse(BaseModel):
    id: int
    store_id: int
    store_name: Optional[str] = None
    posting_number: str
    scheme: str
    status: str
    status_label: str
    deadline_at: Optional[datetime] = None
    deadline_label: Optional[str] = None
    amount: float
    amount_label: Optional[str] = None
    currency: str
    all_waybills: Optional[str] = None
    domestic_waybill: Optional[str] = None
    tracking_no: Optional[str] = None
    sender_name: Optional[str] = None
    product_name: Optional[str] = None
    product_image: Optional[str] = None
    total_pieces: int
    warehouse_status: Optional[str] = None
    responsible_person: Optional[str] = None
    length_mm: float
    width_mm: float
    height_mm: float
    weight_g: float
    estimated_price: float
    total_purchase_price: float
    labeling_fee: float
    warehouse_name: Optional[str] = None
    logistics_type: Optional[str] = None
    inbound_status: str
    printed: bool
    downloaded: bool
    closed: bool
    created_at: Optional[datetime] = None
    created_at_label: Optional[str] = None
    updated_at: Optional[datetime] = None


class OrderListResponse(BaseModel):
    result: List[OrderResponse]
    total: int
    page: int
    page_size: int


class WarehouseBatchRequest(BaseModel):
    ids: List[int] = Field(default_factory=list)


class PricingTemplateBase(BaseModel):
    name: str
    purchase_cost: float = 0.0
    weight_g: float = 0.0
    target_margin_rate: float = 0.0
    length_mm: float = 0.0
    width_mm: float = 0.0
    height_mm: float = 0.0
    domestic_shipping: float = 0.0
    strike_discount_rate: float = 0.0
    ad_rate: float = 0.0
    return_rate: float = 0.0
    other_fee_rate: float = 0.0
    has_battery: bool = False
    has_liquid: bool = False
    logistics_type: str = "FBS"
    pickup_type: str = "Pickup"
    destination_region: str = "Russia"


class PricingTemplateCreate(PricingTemplateBase):
    pass


class PricingTemplateResponse(PricingTemplateBase):
    id: int
    tenant_id: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PricingCalculationRequest(BaseModel):
    purchase_cost: float = 0.0
    weight_g: float = 0.0
    target_margin_rate: float = 0.0
    length_mm: float = 0.0
    width_mm: float = 0.0
    height_mm: float = 0.0
    domestic_shipping: float = 0.0
    strike_discount_rate: float = 0.0
    ad_rate: float = 0.0
    return_rate: float = 0.0
    other_fee_rate: float = 0.0
    has_battery: bool = False
    has_liquid: bool = False
    logistics_type: str = "FBS"
    pickup_type: str = "Pickup"
    destination_region: str = "Russia"


class OrderSyncRequest(BaseModel):
    store_id: Optional[int] = None
    days: int = 30


class OrderSyncResponse(BaseModel):
    message: str
    mode: str = "sync"
    synced_orders: Optional[int] = None
    stores: Optional[int] = None
    skipped: List[str] = Field(default_factory=list)
    task_id: Optional[str] = None
    task_name: Optional[str] = None
    status: Optional[str] = None


class StoreScopedTaskRequest(BaseModel):
    store_id: Optional[int] = None


class AnalyticsRefreshRequest(BaseModel):
    store_id: Optional[int] = None
    days: int = Field(default=7, ge=1, le=365)


class ProductSyncResponse(BaseModel):
    message: str
    mode: str = "sync"
    synced_total: Optional[int] = None
    synced_from_upload_jobs: Optional[int] = None
    synced_from_ozon: Optional[int] = None
    stores: Optional[int] = None
    skipped: List[str] = Field(default_factory=list)
    task_id: Optional[str] = None
    task_name: Optional[str] = None
    status: Optional[str] = None


class AsyncTaskSubmitResponse(BaseModel):
    message: str
    mode: str = "async"
    task_id: str
    task_name: str
    queue: Optional[str] = None
    status: str


class TaskStatusResponse(BaseModel):
    task_id: str
    task_name: Optional[str] = None
    status: str
    ready: bool
    successful: bool
    failed: bool
    result: Optional[Any] = None
    error: Optional[str] = None


class AdminSyncScheduleResponse(BaseModel):
    id: int
    tenant_id: int
    tenant_name: Optional[str] = None
    store_id: Optional[int] = None
    store_name: Optional[str] = None
    name: str
    job_type: str
    enabled: bool
    interval_minutes: int
    days: int
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    last_status: Optional[str] = None
    last_message: Optional[str] = None
    last_task_id: Optional[str] = None
    locked_until: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class AdminSyncScheduleCreateRequest(BaseModel):
    tenant_id: int
    store_id: Optional[int] = None
    name: str
    job_type: str
    enabled: bool = True
    interval_minutes: int = Field(default=120, ge=5)
    days: int = Field(default=7, ge=1, le=90)
    next_run_at: Optional[datetime] = None


class AdminSyncScheduleUpdateRequest(BaseModel):
    tenant_id: Optional[int] = None
    store_id: Optional[int] = None
    name: Optional[str] = None
    job_type: Optional[str] = None
    enabled: Optional[bool] = None
    interval_minutes: Optional[int] = Field(default=None, ge=5)
    days: Optional[int] = Field(default=None, ge=1, le=90)
    next_run_at: Optional[datetime] = None


class AdminSyncRunResponse(BaseModel):
    id: int
    tenant_id: int
    tenant_name: Optional[str] = None
    schedule_id: Optional[int] = None
    store_id: Optional[int] = None
    store_name: Optional[str] = None
    job_type: str
    status: str
    triggered_by: str
    task_id: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    result_payload: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    created_at: Optional[datetime] = None


class AdminTaskMonitorStatusCount(BaseModel):
    status: str
    count: int


class AdminTaskMonitorResponse(BaseModel):
    upload_status_counts: List[AdminTaskMonitorStatusCount]
    upload_active_global_stores: int
    upload_queue_backlog: int
    recent_upload_jobs: List[UploadJobResponse]
    sync_status_counts: List[AdminTaskMonitorStatusCount]
    recent_sync_runs: List[AdminSyncRunResponse]


class AdminSystemAlertResponse(BaseModel):
    code: str
    severity: str
    status: str
    message: str
    value: Optional[float] = None
    threshold: Optional[float] = None


class SyncCoreRequest(BaseModel):
    days: int = 30


class Sourcing1688ProductInput(BaseModel):
    product_id: int
    title: str
    subtitle: Optional[str] = None
    image_url: Optional[str] = None
    product_url: Optional[str] = None
    follow_price: Optional[float] = None
    market_price: Optional[float] = None
    min_follow_price: Optional[float] = None
    weight_g: Optional[float] = None
    monthly_sales: Optional[float] = None


class Sourcing1688CompareRequest(BaseModel):
    items: List[Sourcing1688ProductInput] = Field(default_factory=list)
    max_candidates: int = Field(default=5, ge=1, le=10)


class GenericMessageResponse(BaseModel):
    message: str
