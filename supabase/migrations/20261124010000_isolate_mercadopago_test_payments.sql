alter table public.payments
  add column if not exists environment text not null default 'production';

alter table public.payments
  drop constraint if exists payments_environment_check;

alter table public.payments
  add constraint payments_environment_check
  check (environment in ('production','test'));

create index if not exists payments_environment_status_idx
  on public.payments(environment, status, purpose);

create or replace function public.admin_prepare_test_first_item_payment(
  p_bag_id uuid,
  p_method text
)
returns table(payment_id uuid, amount numeric, base_amount numeric, fee_amount numeric, fee_percent numeric)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_status text;
  v_item_count integer;
  v_base numeric(12,2);
  v_rate numeric(7,4);
  v_card_rate numeric(7,4);
  v_pix_rate numeric(7,4);
  v_fee numeric(12,2);
  v_payment_id uuid;
begin
  if not public.is_staff() then
    raise exception 'Apenas a administração pode iniciar esta cobrança de teste.';
  end if;
  if p_method not in ('pix','card') then
    raise exception 'Escolha Pix ou cartão de crédito.';
  end if;
  select status into v_status from public.bags where id=p_bag_id for update;
  if not found or v_status<>'open' then
    raise exception 'Sacolinha de teste aberta não encontrada.';
  end if;
  select count(*),coalesce(sum(price_snapshot),0) into v_item_count,v_base
  from public.bag_items where bag_id=p_bag_id and status='reserved';
  if v_item_count<>1 or v_base<=0 then
    raise exception 'A cobrança de teste exige exatamente uma primeira peça reservada.';
  end if;
  if exists(select 1 from public.payments where bag_id=p_bag_id and purpose='first_item' and status in ('pending','paid')) then
    raise exception 'Já existe uma cobrança inicial pendente ou paga para esta sacolinha.';
  end if;
  select card_fee_percent,pix_fee_percent into v_card_rate,v_pix_rate
  from public.payment_settings where singleton=true;
  v_rate:=case when p_method='card' then v_card_rate else v_pix_rate end;
  if v_rate is null or v_rate<0 or v_rate>=100 then
    raise exception 'Configure uma taxa válida para a forma de pagamento escolhida.';
  end if;
  v_fee:=case when v_rate=0 then 0 else round(v_base/(1-(v_rate/100))-v_base,2) end;
  insert into public.payments(bag_id,method,amount,status,provider,purpose,base_amount,fee_amount,environment)
  values(p_bag_id,p_method,v_base+v_fee,'pending','mercadopago_test','first_item',v_base,v_fee,'test')
  returning id into v_payment_id;
  return query select v_payment_id,(v_base+v_fee)::numeric,v_base::numeric,v_fee::numeric,v_rate;
end;
$function$;

revoke all on function public.admin_prepare_test_first_item_payment(uuid,text) from public;
revoke all on function public.admin_prepare_test_first_item_payment(uuid,text) from anon;
grant execute on function public.admin_prepare_test_first_item_payment(uuid,text) to authenticated;
