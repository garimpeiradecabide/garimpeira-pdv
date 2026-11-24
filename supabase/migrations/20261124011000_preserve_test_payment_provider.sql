create or replace function public.mp_confirm_first_item_payment(
  p_payment_id uuid,p_provider_payment_id text,p_amount numeric,p_payment_type_id text
)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_payment public.payments%rowtype;
  v_expected_type text;
  v_bag_status text;
  v_item_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Acesso não autorizado.'; end if;
  select * into v_payment from public.payments where id=p_payment_id for update;
  if not found or v_payment.purpose<>'first_item' then raise exception 'Cobrança inicial não encontrada.'; end if;
  if v_payment.status='paid' then
    if v_payment.provider_reference=p_provider_payment_id then return; end if;
    raise exception 'Esta cobrança já foi confirmada com outro pagamento.';
  end if;
  if v_payment.status<>'pending' then raise exception 'Esta cobrança não está pendente.'; end if;
  if round(coalesce(p_amount,0),2)<>round(v_payment.amount,2) then raise exception 'Valor aprovado diferente do valor da cobrança inicial.'; end if;
  v_expected_type:=case when v_payment.method='pix' then 'bank_transfer' else 'credit_card' end;
  if p_payment_type_id<>v_expected_type and p_payment_type_id<>'account_money' then raise exception 'Meio de pagamento aprovado diferente do escolhido no painel.'; end if;
  select status into v_bag_status from public.bags where id=v_payment.bag_id for update;
  if v_bag_status<>'open' then raise exception 'Sacolinha não está aberta.'; end if;
  select count(*) into v_item_count from public.bag_items where bag_id=v_payment.bag_id and status='reserved';
  if v_item_count<>1 then raise exception 'A primeira peça não está mais isolada na sacolinha. Solicite conferência administrativa.'; end if;
  update public.payments set status='paid',
    provider=case when v_payment.environment='test' then 'mercadopago_test' else 'mercadopago' end,
    provider_reference=p_provider_payment_id,provider_payment_type_id=p_payment_type_id,paid_at=now()
  where id=p_payment_id;
end;
$function$;

create or replace function public.mp_confirm_bag_balance_payment(
  p_payment_id uuid,p_provider_payment_id text,p_amount numeric,p_payment_type_id text
)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_payment public.payments%rowtype;
  v_status text;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_first_credit numeric(12,2);
  v_other_balance_credit numeric(12,2);
  v_due numeric(12,2);
  v_expected_type text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Acesso não autorizado.'; end if;
  select * into v_payment from public.payments where id=p_payment_id for update;
  if not found or v_payment.purpose<>'bag_balance' then raise exception 'Cobrança do saldo não encontrada.'; end if;
  if v_payment.status='paid' then
    if v_payment.provider_reference=p_provider_payment_id then return; end if;
    raise exception 'Esta cobrança já foi confirmada com outro pagamento.';
  end if;
  if v_payment.status<>'pending' then raise exception 'Esta cobrança não está pendente.'; end if;
  if round(coalesce(p_amount,0),2)<>round(v_payment.amount,2) then raise exception 'Valor aprovado diferente do valor da cobrança.'; end if;
  v_expected_type:=case when v_payment.method='pix' then 'bank_transfer' else 'credit_card' end;
  if p_payment_type_id<>v_expected_type and p_payment_type_id<>'account_money' then raise exception 'Meio de pagamento aprovado diferente do escolhido no painel.'; end if;
  select status,discount_amount into v_status,v_discount from public.bags where id=v_payment.bag_id for update;
  if not found or v_status<>'open' then raise exception 'Sacolinha não está aberta.'; end if;
  select coalesce(sum(price_snapshot),0) into v_subtotal from public.bag_items where bag_id=v_payment.bag_id and status='reserved';
  select coalesce(sum(base_amount),0) into v_first_credit from public.payments where bag_id=v_payment.bag_id and purpose='first_item' and status='paid';
  if v_first_credit<=0 then raise exception 'A primeira peça precisa estar paga e aprovada antes do saldo.'; end if;
  select coalesce(sum(base_amount),0) into v_other_balance_credit from public.payments where bag_id=v_payment.bag_id and purpose='bag_balance' and status='paid';
  v_due:=greatest(v_subtotal-coalesce(v_discount,0)-v_first_credit-v_other_balance_credit,0);
  if round(v_due,2)<>round(v_payment.base_amount,2) then raise exception 'O saldo da sacolinha mudou depois da geração da cobrança. Solicite uma nova conferência.'; end if;
  update public.payments set status='paid',
    provider=case when v_payment.environment='test' then 'mercadopago_test' else 'mercadopago' end,
    provider_reference=p_provider_payment_id,provider_payment_type_id=p_payment_type_id,paid_at=now()
  where id=p_payment_id;
  update public.bag_items set status='sold' where bag_id=v_payment.bag_id and status='reserved';
  update public.products p set status='sold'
  where exists(select 1 from public.bag_items bi where bi.bag_id=v_payment.bag_id and bi.product_id=p.id and bi.status='sold');
  update public.bags set status='closed',closed_at=now() where id=v_payment.bag_id;
end;
$function$;
