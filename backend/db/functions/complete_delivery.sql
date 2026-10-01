-- Called inside BEGIN/COMMIT by the rider route. One workflow updates delivery,
-- order eligibility, cash settlement and rider availability together.
CREATE OR REPLACE PROCEDURE complete_delivery(p_order_id INTEGER, p_rider_id INTEGER)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_delivery deliveries%ROWTYPE;
BEGIN
  -- Every delivery write locks profile, order, delivery, then payment in that order.
  PERFORM 1 FROM rider_profiles WHERE user_id = p_rider_id FOR UPDATE;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  SELECT * INTO v_delivery FROM deliveries WHERE order_id = p_order_id FOR UPDATE;
  -- Split in two so the route can answer 404 for a delivery that does not
  -- exist and 403 for one that belongs to another rider, which is what it
  -- did when these checks lived in JavaScript. pickup_delivery() in
  -- order_lifecycle.sql raises the same two names.
  IF v_delivery.id IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND';
  END IF;
  IF v_delivery.rider_id <> p_rider_id THEN
    RAISE EXCEPTION 'DELIVERY_NOT_ASSIGNED';
  END IF;
  IF v_delivery.delivery_status <> 'picked_up' OR v_order.status <> 'out_for_delivery' THEN
    RAISE EXCEPTION 'INVALID_DELIVERY_TRANSITION';
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = p_order_id
             AND method <> 'cash_on_delivery' AND status <> 'paid') THEN
    RAISE EXCEPTION 'PAYMENT_NOT_VERIFIED';
  END IF;
  UPDATE deliveries SET delivery_status = 'delivered', delivery_time = CURRENT_TIMESTAMP
    WHERE order_id = p_order_id;
  UPDATE orders SET status = 'delivered', review_eligible = true WHERE id = p_order_id;
  UPDATE payments SET status = 'paid', paid_at = CURRENT_TIMESTAMP
    WHERE order_id = p_order_id AND method = 'cash_on_delivery' AND status = 'unpaid';
  UPDATE rider_profiles SET status = 'online' WHERE user_id = p_rider_id;
END;
$$;
