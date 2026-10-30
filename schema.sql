-- ============================================================
-- schema.sql
-- Полная схема для приложения «Контроль контрагентов»
-- Выполнять в SQL Editor проекта Supabase
-- ============================================================

-- Включаем необходимые расширения
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Таблица контрагентов
-- ============================================================
CREATE TABLE IF NOT EXISTS public.counterparties (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    is_allowed      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID REFERENCES auth.users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID REFERENCES auth.users(id),
    archived_at     TIMESTAMPTZ NULL
);

-- Уникальность названия среди неархивированных (без учёта регистра)
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparties_name_unique
    ON public.counterparties (LOWER(TRIM(name)))
    WHERE archived_at IS NULL;

-- Индексы для производительности
CREATE INDEX IF NOT EXISTS idx_counterparties_is_allowed
    ON public.counterparties (is_allowed)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_counterparties_archived
    ON public.counterparties (archived_at);

CREATE INDEX IF NOT EXISTS idx_counterparties_created_at
    ON public.counterparties (created_at DESC);

-- ============================================================
-- Таблица истории действий (audit log)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counterparty_id     UUID NULL,                     -- может быть NULL после архивации/удаления
    counterparty_name   TEXT NOT NULL,                 -- название на момент события
    actor_id            UUID REFERENCES auth.users(id),
    actor_email         TEXT NOT NULL,
    action              TEXT NOT NULL,                 -- 'created', 'status_changed', 'renamed', 'archived'
    old_status          BOOLEAN NULL,
    new_status          BOOLEAN NULL,
    old_name            TEXT NULL,
    new_name            TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
    ON public.audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_counterparty_id
    ON public.audit_log (counterparty_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id
    ON public.audit_log (actor_id);

-- ============================================================
-- Функция для автоматического обновления updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_counterparties_updated_at ON public.counterparties;
CREATE TRIGGER trg_counterparties_updated_at
    BEFORE UPDATE ON public.counterparties
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- Функция безопасного изменения статуса + запись в историю
-- (одна транзакция)
-- ============================================================
CREATE OR REPLACE FUNCTION public.change_counterparty_status(
    p_id UUID,
    p_new_allowed BOOLEAN
)
RETURNS public.counterparties
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.counterparties;
    v_actor_id UUID;
    v_actor_email TEXT;
BEGIN
    -- Проверяем авторизацию
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Не авторизован';
    END IF;

    SELECT email INTO v_actor_email
    FROM auth.users
    WHERE id = v_actor_id;

    -- Получаем текущую запись с блокировкой
    SELECT * INTO v_row
    FROM public.counterparties
    WHERE id = p_id AND archived_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Контрагент не найден или архивирован';
    END IF;

    -- Если статус не меняется — ничего не делаем
    IF v_row.is_allowed = p_new_allowed THEN
        RETURN v_row;
    END IF;

    -- Обновляем статус
    UPDATE public.counterparties
    SET
        is_allowed = p_new_allowed,
        updated_by = v_actor_id
    WHERE id = p_id
    RETURNING * INTO v_row;

    -- Пишем в историю
    INSERT INTO public.audit_log (
        counterparty_id,
        counterparty_name,
        actor_id,
        actor_email,
        action,
        old_status,
        new_status
    ) VALUES (
        v_row.id,
        v_row.name,
        v_actor_id,
        COALESCE(v_actor_email, 'unknown'),
        'status_changed',
        NOT p_new_allowed,   -- старый статус
        p_new_allowed
    );

    RETURN v_row;
END;
$$;

-- ============================================================
-- Функция создания контрагента + запись в историю
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_counterparty(
    p_name TEXT
)
RETURNS public.counterparties
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.counterparties;
    v_actor_id UUID;
    v_actor_email TEXT;
    v_clean_name TEXT;
BEGIN
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Не авторизован';
    END IF;

    v_clean_name := TRIM(p_name);
    IF v_clean_name = '' OR v_clean_name IS NULL THEN
        RAISE EXCEPTION 'Название не может быть пустым';
    END IF;

    -- Проверка на дубликат (без учёта регистра)
    IF EXISTS (
        SELECT 1 FROM public.counterparties
        WHERE LOWER(TRIM(name)) = LOWER(v_clean_name)
          AND archived_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Контрагент с похожим названием уже существует';
    END IF;

    SELECT email INTO v_actor_email
    FROM auth.users
    WHERE id = v_actor_id;

    INSERT INTO public.counterparties (
        name,
        is_allowed,
        created_by,
        updated_by
    ) VALUES (
        v_clean_name,
        TRUE,
        v_actor_id,
        v_actor_id
    )
    RETURNING * INTO v_row;

    INSERT INTO public.audit_log (
        counterparty_id,
        counterparty_name,
        actor_id,
        actor_email,
        action,
        new_status
    ) VALUES (
        v_row.id,
        v_row.name,
        v_actor_id,
        COALESCE(v_actor_email, 'unknown'),
        'created',
        TRUE
    );

    RETURN v_row;
END;
$$;

-- ============================================================
-- Функция архивирования (мягкое удаление) + запись в историю
-- ============================================================
CREATE OR REPLACE FUNCTION public.archive_counterparty(
    p_id UUID
)
RETURNS public.counterparties
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.counterparties;
    v_actor_id UUID;
    v_actor_email TEXT;
BEGIN
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Не авторизован';
    END IF;

    SELECT * INTO v_row
    FROM public.counterparties
    WHERE id = p_id AND archived_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Контрагент не найден или уже архивирован';
    END IF;

    SELECT email INTO v_actor_email
    FROM auth.users
    WHERE id = v_actor_id;

    UPDATE public.counterparties
    SET
        archived_at = NOW(),
        updated_by = v_actor_id
    WHERE id = p_id
    RETURNING * INTO v_row;

    INSERT INTO public.audit_log (
        counterparty_id,
        counterparty_name,
        actor_id,
        actor_email,
        action,
        old_status
    ) VALUES (
        v_row.id,
        v_row.name,
        v_actor_id,
        COALESCE(v_actor_email, 'unknown'),
        'archived',
        v_row.is_allowed
    );

    RETURN v_row;
END;
$$;

-- ============================================================
-- Функция переименования + запись в историю
-- ============================================================
CREATE OR REPLACE FUNCTION public.rename_counterparty(
    p_id UUID,
    p_new_name TEXT
)
RETURNS public.counterparties
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.counterparties;
    v_actor_id UUID;
    v_actor_email TEXT;
    v_clean_name TEXT;
    v_old_name TEXT;
BEGIN
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Не авторизован';
    END IF;

    v_clean_name := TRIM(p_new_name);
    IF v_clean_name = '' OR v_clean_name IS NULL THEN
        RAISE EXCEPTION 'Название не может быть пустым';
    END IF;

    SELECT * INTO v_row
    FROM public.counterparties
    WHERE id = p_id AND archived_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Контрагент не найден или архивирован';
    END IF;

    v_old_name := v_row.name;

    IF LOWER(TRIM(v_old_name)) = LOWER(v_clean_name) THEN
        RETURN v_row; -- ничего не изменилось
    END IF;

    -- Проверка дубликата
    IF EXISTS (
        SELECT 1 FROM public.counterparties
        WHERE LOWER(TRIM(name)) = LOWER(v_clean_name)
          AND archived_at IS NULL
          AND id <> p_id
    ) THEN
        RAISE EXCEPTION 'Контрагент с похожим названием уже существует';
    END IF;

    SELECT email INTO v_actor_email
    FROM auth.users
    WHERE id = v_actor_id;

    UPDATE public.counterparties
    SET
        name = v_clean_name,
        updated_by = v_actor_id
    WHERE id = p_id
    RETURNING * INTO v_row;

    INSERT INTO public.audit_log (
        counterparty_id,
        counterparty_name,
        actor_id,
        actor_email,
        action,
        old_name,
        new_name
    ) VALUES (
        v_row.id,
        v_clean_name,
        v_actor_id,
        COALESCE(v_actor_email, 'unknown'),
        'renamed',
        v_old_name,
        v_clean_name
    );

    RETURN v_row;
END;
$$;

-- ============================================================
-- Права на выполнение функций
-- ============================================================
GRANT EXECUTE ON FUNCTION public.change_counterparty_status(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_counterparty(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_counterparty(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rename_counterparty(UUID, TEXT) TO authenticated;

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================
ALTER TABLE public.counterparties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Политики для counterparties
-- Читать могут только авторизованные (неархивированные)
DROP POLICY IF EXISTS "Authenticated users can select non-archived counterparties" ON public.counterparties;
CREATE POLICY "Authenticated users can select non-archived counterparties"
    ON public.counterparties
    FOR SELECT
    TO authenticated
    USING (archived_at IS NULL);

-- Прямые INSERT/UPDATE/DELETE запрещены — только через функции
DROP POLICY IF EXISTS "No direct insert" ON public.counterparties;
CREATE POLICY "No direct insert"
    ON public.counterparties
    FOR INSERT
    TO authenticated
    WITH CHECK (false);

DROP POLICY IF EXISTS "No direct update" ON public.counterparties;
CREATE POLICY "No direct update"
    ON public.counterparties
    FOR UPDATE
    TO authenticated
    USING (false);

DROP POLICY IF EXISTS "No direct delete" ON public.counterparties;
CREATE POLICY "No direct delete"
    ON public.counterparties
    FOR DELETE
    TO authenticated
    USING (false);

-- Политики для audit_log
-- Читать могут все авторизованные
DROP POLICY IF EXISTS "Authenticated users can select audit_log" ON public.audit_log;
CREATE POLICY "Authenticated users can select audit_log"
    ON public.audit_log
    FOR SELECT
    TO authenticated
    USING (true);

-- Прямой INSERT только через SECURITY DEFINER функции (они обходят RLS)
DROP POLICY IF EXISTS "No direct insert audit" ON public.audit_log;
CREATE POLICY "No direct insert audit"
    ON public.audit_log
    FOR INSERT
    TO authenticated
    WITH CHECK (false);

DROP POLICY IF EXISTS "No update audit" ON public.audit_log;
CREATE POLICY "No update audit"
    ON public.audit_log
    FOR UPDATE
    TO authenticated
    USING (false);

DROP POLICY IF EXISTS "No delete audit" ON public.audit_log;
CREATE POLICY "No delete audit"
    ON public.audit_log
    FOR DELETE
    TO authenticated
    USING (false);

-- ============================================================
-- Включение Realtime
-- ============================================================
-- В Dashboard: Database → Replication → включить таблицы
-- или выполнить:
ALTER PUBLICATION supabase_realtime ADD TABLE public.counterparties;
ALTER PUBLICATION supabase_realtime ADD TABLE public.audit_log;

-- ============================================================
-- Комментарии
-- ============================================================
COMMENT ON TABLE public.counterparties IS 'Список контрагентов с статусом разрешения закупки';
COMMENT ON TABLE public.audit_log IS 'История всех действий сотрудников';
COMMENT ON FUNCTION public.change_counterparty_status IS 'Безопасное изменение статуса + запись в историю в одной транзакции';
COMMENT ON FUNCTION public.create_counterparty IS 'Создание контрагента + запись в историю';
COMMENT ON FUNCTION public.archive_counterparty IS 'Мягкое удаление (архивация) + запись в историю';
COMMENT ON FUNCTION public.rename_counterparty IS 'Переименование + запись в историю';
