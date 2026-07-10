"use client";

import type { ActionResult, CreditOrderListDto } from "@cunote/contracts";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ORDER_STATUS_LABEL: Record<string, string> = {
  created: "결제 대기",
  pending: "결제 대기",
  paid: "충전 완료",
  failed: "실패",
  expired: "만료",
  refunded: "환불",
  partial_refunded: "부분 환불",
};

export function RecentOrdersList({ limit = 5 }: { limit?: number }) {
  const [orders, setOrders] = useState<CreditOrderListDto["orders"]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/web/credits/orders?limit=${limit}`);
        const result = (await res.json()) as ActionResult<CreditOrderListDto>;
        if (!cancelled && result.ok && result.data) setOrders(result.data.orders);
      } catch {
        // 조용히 무시 — 주문 내역은 보조 정보.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [limit]);

  if (loading) return null;
  if (orders.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">최근 충전 내역</CardTitle>
        <CardDescription>최근 {limit}건. 전체 내역은 사용량 상세에서 확인할 수 있습니다.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>충전</TableHead>
              <TableHead>일시</TableHead>
              <TableHead className="text-right">상태</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <TableRow key={o.paymentId}>
                <TableCell className="font-medium text-foreground">
                  {o.amountKrw.toLocaleString("ko-KR")}원 · {o.creditsToGrant.toLocaleString("ko-KR")} 크레딧
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(o.createdAt).toLocaleString("ko-KR")}
                  {o.payMethod ? ` · ${o.payMethod}` : ""}
                </TableCell>
                <TableCell className="text-right text-xs font-medium text-muted-foreground">
                  {ORDER_STATUS_LABEL[o.status] ?? o.status}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
